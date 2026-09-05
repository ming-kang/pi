import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import {
	BACKGROUND_DETAILS_BYTES,
	BACKGROUND_RESULT_BYTES,
	boundedResult,
	boundText,
	finiteLimit,
	readOutputSlice,
	sliceText,
} from "./output.ts";
import {
	type BackgroundCompletion,
	type BackgroundContext,
	type BackgroundControl,
	type BackgroundExecution,
	BackgroundExecutionError,
	type BackgroundProjection,
	type BackgroundRead,
	type BackgroundServiceOptions,
	type BackgroundTask,
	type BackgroundToolOutcome,
	type BackgroundWorker,
	SUBAGENT_BACKGROUND_REJECTION,
} from "./types.ts";

interface RecordState {
	task: BackgroundTask;
	controller: AbortController;
	accepted: boolean;
	handedOff: boolean;
	detachRequested: boolean;
	settled: boolean;
	accounted: boolean;
	visible: boolean;
	suppressed: boolean;
	delivery: "pending" | "claimed" | "delivered";
	pins: number;
	cleanup?: () => void | Promise<void>;
	readError?: string;
	publishedUsage?: Usage;
	waiters: Set<() => void>;
	removeParent: () => void;
	handoff: () => void;
	done: Promise<void>;
}

function errorText(error: unknown): string {
	try {
		return boundText(error instanceof Error ? error.message : String(error), 4096);
	} catch {
		return "Background execution failed (unprintable error)";
	}
}

function projectionSnapshot(projection: BackgroundProjection): BackgroundProjection {
	return {
		text: projection.text === undefined ? undefined : boundText(projection.text, 16 * 1024),
		workers: projection.workers?.slice(0, 8).map((worker) => ({
			id: boundText(worker.id, 256),
			label: boundText(worker.label, 512),
			status: boundText(worker.status, 128),
			prompt: boundText(worker.prompt, 4096),
			activity: boundText(worker.activity, 4096),
			outcome: boundText(worker.outcome, 4096),
			model: worker.model === undefined ? undefined : boundText(worker.model, 256),
			usage: worker.usage === undefined ? undefined : boundText(worker.usage, 256),
		})),
	};
}

/** Read persisted data properties only; never invoke getters or custom serialization. */
function dataObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected plain object");
	return value as Record<string, unknown>;
}

function field(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor && !("value" in descriptor)) throw new Error("Unexpected accessor");
	return descriptor?.value;
}

function historyString(value: unknown, bytes: number, exact = false): string {
	if (typeof value !== "string") throw new Error("Expected string");
	if (exact && (!value || value.length > bytes || Buffer.byteLength(value) > bytes || value.includes("\0")))
		throw new Error("Invalid identity or path");
	return boundText(value, bytes);
}

/** Bound traversal before serialization, and omit unsupported/oversized details intact. */
function historyDetails(value: unknown): unknown {
	let budget = BACKGROUND_DETAILS_BYTES;
	function copy(value: unknown, depth: number): unknown {
		if (--budget < 0 || depth > 32) throw new Error("History details too large");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			budget -= value.length;
			if (budget < 0) throw new Error("History details too large");
			return value;
		}
		if (Array.isArray(value)) {
			if (value.length > budget) throw new Error("History details too large");
			return Array.from({ length: value.length }, (_, index) => copy(field(value, String(index)), depth + 1));
		}
		const object = dataObject(value);
		const out: Record<string, unknown> = Object.create(null);
		for (const key in object) {
			if (!Object.hasOwn(object, key)) continue;
			budget -= key.length + 3;
			out[key] = copy(field(object, key), depth + 1);
		}
		return out;
	}
	try {
		return copy(value, 0);
	} catch {
		return undefined;
	}
}

function historyTask(record: unknown): BackgroundTask | undefined {
	try {
		const envelope = dataObject(record);
		if (field(envelope, "version") !== 1) return undefined;
		const source = dataObject(field(envelope, "task"));
		const kind = field(source, "kind");
		const mode = field(source, "mode");
		const status = field(source, "status");
		if (kind !== "bash" && kind !== "subagent") return undefined;
		if (mode !== "foreground" && mode !== "background") return undefined;
		if (
			status !== "completed" &&
			status !== "partial" &&
			status !== "failed" &&
			status !== "cancelled" &&
			status !== "timeout"
		)
			return undefined;
		const startedAt = field(source, "startedAt");
		const endedAt = field(source, "endedAt");
		if (
			typeof startedAt !== "number" ||
			!Number.isSafeInteger(startedAt) ||
			startedAt < 0 ||
			typeof endedAt !== "number" ||
			!Number.isSafeInteger(endedAt) ||
			endedAt < startedAt
		)
			return undefined;
		const anchor = field(source, "anchorId");
		const task: BackgroundTask = {
			id: historyString(field(source, "id"), 512, true),
			kind,
			mode,
			status,
			startedAt,
			endedAt,
			title: historyString(field(source, "title"), 1024),
			toolCallId: historyString(field(source, "toolCallId"), 512, true),
			anchorId: anchor === null ? null : historyString(anchor, 8192, true),
		};
		if (!task.id.startsWith(`${kind}-`) || task.id.length <= kind.length + 1) return undefined;
		for (const [key, bytes] of [
			["command", 8192],
			["cwd", 4096],
			["error", 4096],
			["outputPath", 8192],
		] as const) {
			const value = field(source, key);
			if (value !== undefined) task[key] = historyString(value, bytes, key === "outputPath");
		}
		const projection = field(source, "projection");
		if (projection !== undefined) {
			const object = dataObject(projection);
			const text = field(object, "text");
			const workers = field(object, "workers");
			task.projection = {};
			if (text !== undefined) task.projection.text = historyString(text, 16 * 1024);
			if (workers !== undefined) {
				if (!Array.isArray(workers)) return undefined;
				task.projection.workers = Array.from({ length: Math.min(workers.length, 8) }, (_, index) => {
					const worker = dataObject(field(workers, String(index)));
					const snapshot: BackgroundWorker = {
						id: historyString(field(worker, "id"), 256),
						label: historyString(field(worker, "label"), 512),
						status: historyString(field(worker, "status"), 128),
						prompt: historyString(field(worker, "prompt"), 4096),
						activity: historyString(field(worker, "activity"), 4096),
						outcome: historyString(field(worker, "outcome"), 4096),
					};
					for (const key of ["model", "usage"] as const) {
						const value = field(worker, key);
						if (value !== undefined) snapshot[key] = historyString(value, 256);
					}
					return snapshot;
				});
			}
		}
		const result = field(source, "result");
		if (result !== undefined) {
			const object = dataObject(result);
			const blocks = field(object, "content");
			if (!Array.isArray(blocks)) return undefined;
			const content: AgentToolResult<unknown>["content"] = [];
			let remaining = BACKGROUND_RESULT_BYTES;
			for (let index = 0; index < blocks.length && remaining > 0; index++) {
				const block = dataObject(field(blocks, String(index)));
				const type = field(block, "type");
				if (type !== "text" && type !== "image") return undefined;
				const text =
					type === "text"
						? historyString(field(block, "text"), remaining)
						: "[Image omitted from background history]";
				content.push({ type: "text", text });
				remaining -= Math.max(1, Buffer.byteLength(text));
			}
			task.result = boundedResult({ content, details: historyDetails(field(object, "details")) });
		}
		return task;
	} catch {
		return undefined;
	}
}

/** Session-local supervision. Executors own their processes, workers and output files. */
export class BackgroundService implements BackgroundContext {
	private readonly records = new Map<string, RecordState>();
	private readonly listeners = new Set<() => void>();
	private readonly maxActive: number;
	private readonly maxHistory: number;
	private configuredEnabled: boolean;
	private _closed = false;
	private readonly cleanups = new Set<Promise<void>>();

	get closed(): boolean {
		return this._closed;
	}
	private pauses = 0;

	private readonly options: BackgroundServiceOptions;

	constructor(options: BackgroundServiceOptions = {}) {
		this.options = options;
		this.configuredEnabled = options.enabled ?? false;
		this.maxActive = Math.max(1, finiteLimit(options.maxActive, 8, 128));
		this.maxHistory = finiteLimit(options.maxHistory, 32, 1024);
	}

	/**
	 * Rehydrate terminal version-1 custom data only, newest endedAt first (later input
	 * wins ties). Existing runtime records win ID collisions. No execution, accounting,
	 * notification, or deletion ownership is restored, including for worker projections.
	 * The host supplies the current branch; closed services ignore restoration.
	 */
	restoreHistory(records: readonly unknown[]): void {
		if (this.closed) return;
		// Restoration must not evict runtime-owned records or run their cleanup callbacks.
		const capacity = Math.max(
			0,
			this.maxHistory - [...this.records.values()].filter((record) => record.settled).length,
		);
		const newest = new Map<string, BackgroundTask>();
		for (const value of records) {
			const task = historyTask(value);
			if (!task) continue;
			const existing = this.records.get(task.id);
			if (existing) {
				if (existing.settled) existing.visible = true;
				continue;
			}
			if (capacity === 0) continue;
			const previous = newest.get(task.id);
			if (previous && previous.endedAt! > task.endedAt!) continue;
			newest.delete(task.id);
			newest.set(task.id, task);
			if (newest.size > capacity) {
				let oldest: BackgroundTask | undefined;
				for (const candidate of newest.values()) {
					if (!oldest || candidate.endedAt! < oldest.endedAt!) oldest = candidate;
				}
				newest.delete(oldest!.id);
			}
		}
		for (const task of [...newest.values()].sort((a, b) => a.endedAt! - b.endedAt!)) {
			this.records.set(task.id, {
				task,
				controller: new AbortController(),
				accepted: false,
				handedOff: false,
				detachRequested: false,
				settled: true,
				accounted: true,
				visible: true,
				suppressed: true,
				delivery: "delivered",
				pins: 0,
				waiters: new Set(),
				removeParent: () => {},
				handoff: () => {},
				done: Promise.resolve(),
			});
		}
	}

	get enabled(): boolean {
		return this.configuredEnabled && !this.closed && this.options.role !== "subagent";
	}

	setEnabled(enabled: boolean): void {
		this.configuredEnabled = enabled;
		this.emit();
	}

	async execute<T>(execution: BackgroundExecution<T>): Promise<BackgroundToolOutcome<T>> {
		// Admission and registration happen synchronously, before invoking user code or awaiting anything.
		if (this.options.role === "subagent") throw new Error(SUBAGENT_BACKGROUND_REJECTION);
		if (this.closed) throw new Error("Background service is closed");
		if (!this.enabled) throw new Error("Background execution is not available in this host");
		if (execution.signal?.aborted) throw execution.signal.reason ?? new Error("Execution aborted");
		if ([...this.records.values()].filter((record) => !record.settled).length >= this.maxActive) {
			throw new Error(`Background execution limit reached (${this.maxActive})`);
		}
		if (this.records.size + this.cleanups.size >= this.maxActive + 2 * Math.max(1, this.maxHistory)) {
			throw new Error(
				"Background history retention limit reached; deliver pending notifications or release pinned or claimed records",
			);
		}
		const anchorId = this.options.anchor?.() ?? null;
		if (anchorId !== null && Buffer.byteLength(anchorId) > 8192)
			throw new Error("Background branch anchor is too large");
		const task: BackgroundTask = {
			id: `${execution.kind}-${randomUUID()}`,
			kind: execution.kind,
			title: boundText(execution.title, 1024),
			toolCallId: boundText(execution.toolCallId, 512),
			anchorId,
			mode: execution.background ? "background" : "foreground",
			status: "queued",
			startedAt: Date.now(),
			command: execution.command === undefined ? undefined : boundText(execution.command, 8192),
			cwd: execution.cwd === undefined ? undefined : boundText(execution.cwd, 4096),
		};
		let resolveCaller!: (outcome: BackgroundToolOutcome<T>) => void;
		let rejectCaller!: (error: unknown) => void;
		const caller = new Promise<BackgroundToolOutcome<T>>((resolve, reject) => {
			resolveCaller = resolve;
			rejectCaller = reject;
		});
		let resolveDone!: () => void;
		const record: RecordState = {
			task,
			controller: new AbortController(),
			accepted: false,
			handedOff: false,
			detachRequested: execution.background ?? false,
			settled: false,
			accounted: false,
			visible: true,
			suppressed: false,
			delivery: "pending",
			pins: 0,
			waiters: new Set(),
			removeParent: () => {},
			handoff: () => {
				if (
					!record.accepted ||
					!record.detachRequested ||
					record.settled ||
					record.handedOff ||
					this.closed ||
					record.suppressed ||
					record.controller.signal.aborted
				)
					return;
				record.handedOff = true;
				task.mode = "background";
				record.removeParent();
				resolveCaller({ kind: "background", task: this.snapshot(record) });
				this.emit();
			},
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
		};
		const parentSignal = execution.signal;
		let onUpdate = execution.background ? undefined : execution.onUpdate;
		const parentAbort = () => {
			if (!record.detachRequested || !record.accepted) this.cancel(record);
		};
		parentSignal?.addEventListener("abort", parentAbort, { once: true });
		record.removeParent = () => {
			parentSignal?.removeEventListener("abort", parentAbort);
			onUpdate = undefined;
		};
		this.records.set(task.id, record);
		const control: BackgroundControl<T> = {
			id: task.id,
			signal: record.controller.signal,
			get mode() {
				return task.mode;
			},
			accept: () => {
				if (record.settled || record.accepted || this.closed || record.controller.signal.aborted) return;
				record.accepted = true;
				if (task.status === "queued") task.status = "running";
				if (record.detachRequested) record.removeParent();
				// Let an already available final result win over a handoff.
				queueMicrotask(() => queueMicrotask(record.handoff));
				this.emit();
			},
			publish: (result, projection) => {
				if (record.settled || this.closed) return;
				task.result = boundedResult(result);
				if (result.usage !== undefined) record.publishedUsage = structuredClone(result.usage);
				if (projection) task.projection = projectionSnapshot(projection);
				if (!record.detachRequested && !record.handedOff) {
					try {
						onUpdate?.(result);
					} catch {
						/* UI observers cannot stop execution. */
					}
				}
				this.emit();
			},
			setOutputPath: (path, cleanup) => {
				if (record.settled) {
					if (cleanup) throw new Error("Background execution has settled");
					return;
				}
				if (record.cleanup) throw new Error("Managed output is already registered");
				if (Buffer.byteLength(path) > 8192) throw new Error("Background output path is too large");
				record.cleanup = cleanup;
				// Never truncate a real filesystem path into a different path.
				if (Buffer.byteLength(path) <= 8192) task.outputPath = path;
				this.emit();
			},
		};
		const finish = (completion: BackgroundCompletion<T> | undefined, error?: unknown) => {
			if (record.settled) return;
			record.settled = true;
			record.removeParent();
			task.endedAt = Date.now();
			const failed = completion === undefined;
			task.status =
				completion?.status ??
				(error instanceof BackgroundExecutionError
					? error.status
					: record.controller.signal.aborted
						? "cancelled"
						: failed
							? "failed"
							: "completed");
			if (completion) {
				task.result = boundedResult(completion.result);
				if (completion.error !== undefined) task.error = boundText(completion.error, 4096);
			}
			if (failed) {
				task.error = errorText(error);
				task.result = boundedResult({
					content: [{ type: "text", text: task.error }, ...(task.result?.content ?? [])],
					details: task.result?.details,
				});
			}
			try {
				this.options.onSettled?.(
					this.snapshot(record),
					completion?.usage ?? completion?.result.usage ?? record.publishedUsage,
				);
			} catch (accountingError) {
				const warning = `Usage settlement failed: ${errorText(accountingError)}`;
				task.error = boundText([task.error, warning].filter(Boolean).join("\n"), 8192);
				task.result = boundedResult({
					content: [{ type: "text", text: warning }, ...(task.result?.content ?? [])],
					details: task.result?.details,
				});
			}
			record.publishedUsage = undefined;
			record.accounted = true;
			if (!record.handedOff) {
				record.delivery = "delivered";
				if (failed) rejectCaller(error);
				else {
					const { usage: _usage, ...result } = completion.result;
					if (task.error) result.content = [{ type: "text", text: task.error }, ...result.content];
					resolveCaller({ kind: "result", result, status: task.status, error: task.error });
				}
			}
			for (const waiter of [...record.waiters]) waiter();
			resolveDone();
			this.trim();
			this.emit();
		};
		// The rejection handler is installed immediately, including for synchronous preflight throws.
		try {
			const running = execution.run(control);
			void Promise.resolve(running).then(
				(result) => finish(result),
				(error: unknown) => finish(undefined, error),
			);
		} catch (error) {
			finish(undefined, error);
		}
		this.emit();
		return caller;
	}

	detachForeground(): number {
		if (!this.enabled) return 0;
		const records = [...this.records.values()].filter(
			(record) => !record.settled && !record.detachRequested && !record.controller.signal.aborted,
		);
		// Update the whole batch before callbacks/observers can re-enter.
		for (const record of records) {
			record.detachRequested = true;
			record.task.mode = "background";
			if (record.accepted) record.removeParent();
		}
		for (const record of records) record.handoff();
		if (records.length) this.emit();
		return records.length;
	}

	list(): BackgroundTask[] {
		return [...this.records.values()].filter((record) => record.visible).map((record) => this.snapshot(record));
	}

	private lookup(id: string): RecordState {
		const exact = this.records.get(id);
		if (exact) return exact;
		const matches = [...this.records.values()].filter(
			({ task }) => task.id.startsWith(id) || task.id.slice(task.kind.length + 1).startsWith(id),
		);
		if (!id || matches.length !== 1)
			throw new Error(matches.length > 1 ? "Ambiguous background task ID" : "Unknown background task ID");
		return matches[0]!;
	}

	get(id: string): BackgroundTask {
		return this.snapshot(this.lookup(id));
	}

	async read(
		id: string,
		options: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number } = {},
	): Promise<BackgroundRead> {
		const record = this.lookup(id);
		const release = this.pin(record.task.id);
		try {
			const task = this.snapshot(record);
			if (task.outputPath) {
				try {
					return { task, ...(await readOutputSlice(task.outputPath, options)) };
				} catch (error) {
					return {
						task,
						readError: boundText(`Output could not be read: ${errorText(error)}`, 4096),
						...sliceText(this.resultText(task), options),
					};
				}
			}
			return { task, readError: record.readError, ...sliceText(this.resultText(task), options) };
		} finally {
			release();
		}
	}

	private resultText(task: BackgroundTask): string {
		return boundText(
			task.result?.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n") ||
				task.projection?.text ||
				task.error ||
				"No output yet.",
		);
	}

	/** Observe completion without consuming delivery; the host acknowledges only persisted tool results. */
	async wait(id: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<BackgroundTask> {
		if (signal?.aborted) throw signal.reason ?? new Error("Wait aborted");
		const record = this.lookup(id);
		if (record.settled) return this.snapshot(record);
		return new Promise<BackgroundTask>((resolve, reject) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const complete = (aborted = false) => {
				if (finished) return;
				finished = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				record.waiters.delete(wake);
				if (aborted) reject(signal?.reason ?? new Error("Wait aborted"));
				else resolve(this.snapshot(record));
				this.trim();
				this.emit();
			};
			const wake = () => complete();
			const abort = () => complete(true);
			record.waiters.add(wake);
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(wake, finiteLimit(timeoutMs, 20_000, 60_000));
			if (this.closed) wake();
		});
	}

	kill(id: string): boolean {
		return this.cancel(this.lookup(id));
	}

	private cancel(record: RecordState): boolean {
		if (record.settled || record.controller.signal.aborted) return false;
		record.task.status = "stopping";
		record.controller.abort();
		this.emit();
		return true;
	}

	subscribe(listener: () => void): () => void {
		if (this.closed) return () => {};
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	pin(id: string): () => void {
		const record = this.lookup(id);
		record.pins++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			record.pins--;
			this.trim();
		};
	}

	pause(): () => void {
		this.pauses++;
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.pauses--;
			this.emit();
		};
	}

	pendingNotifications(): BackgroundTask[] {
		if (this.closed || this.pauses > 0) return [];
		return [...this.records.values()]
			.filter((record) => this.candidate(record))
			.map((record) => this.snapshot(record));
	}

	private candidate(record: RecordState): boolean {
		return (
			record.visible &&
			record.settled &&
			record.accounted &&
			record.handedOff &&
			!record.suppressed &&
			record.delivery === "pending" &&
			record.waiters.size === 0
		);
	}

	claimNotification(id: string): boolean {
		if (this.closed || this.pauses > 0) return false;
		const record = this.records.get(id);
		if (!record || !this.candidate(record)) return false;
		record.delivery = "claimed";
		return true;
	}

	markDelivered(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		record.delivery = "delivered";
		this.trim();
	}

	releaseNotification(id: string): void {
		const record = this.records.get(id);
		if (!record || record.delivery !== "claimed") return;
		record.delivery = "pending";
		this.trim();
		this.emit();
	}

	close(): void {
		if (this.closed) return;
		this._closed = true;
		this.listeners.clear();
		for (const record of this.records.values()) {
			record.suppressed = true;
			record.removeParent();
			this.cancel(record);
			for (const waiter of [...record.waiters]) waiter();
		}
		this.trim();
	}

	async shutdown(graceMs = 2000): Promise<void> {
		this.close();
		await this.drain([...this.records.values()], graceMs);
	}

	async cancelOutsideBranch(ancestors: ReadonlySet<string>): Promise<void> {
		for (const record of this.records.values()) {
			record.visible = record.task.anchorId === null || ancestors.has(record.task.anchorId);
		}
		const outside = [...this.records.values()].filter((record) => !record.visible);
		for (const record of outside) record.suppressed = true;
		for (const record of outside) this.cancel(record);
		this.emit();
		await this.drain(outside, 2000);
	}

	private async drain(records: RecordState[], graceMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(records.map((record) => record.done)).then(() => Promise.all(this.cleanups)),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, finiteLimit(graceMs, 2000, 60_000));
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private snapshot(record: RecordState): BackgroundTask {
		return structuredClone(record.task);
	}

	private cleanupOutput(record: RecordState): void {
		if (!record.settled || record.pins || record.waiters.size || !record.cleanup) return;
		const cleanup = record.cleanup;
		record.cleanup = undefined;
		// Snapshots retain final bounded text; expired files are never needed to render history.
		record.task.outputPath = undefined;
		record.readError = "Output has expired: the managed log was released; showing the stored result.";
		const pending = Promise.resolve()
			.then(cleanup)
			.catch((error: unknown) => {
				try {
					this.options.onCleanupError?.(errorText(error));
				} catch {
					/* Cleanup/reporting is best effort, never an unhandled rejection. */
				}
			})
			.finally(() => this.cleanups.delete(pending));
		this.cleanups.add(pending);
	}

	private trim(): void {
		if (this.closed) {
			for (const record of this.records.values()) this.cleanupOutput(record);
			return;
		}
		// Undelivered notifications and claims are never evicted. Admission bounds all retention.
		const history = [...this.records.values()].filter(
			(record) =>
				record.settled &&
				!record.pins &&
				!record.waiters.size &&
				record.delivery !== "claimed" &&
				(!record.handedOff || record.suppressed || record.delivery === "delivered"),
		);
		history.sort((left, right) => (left.task.endedAt ?? 0) - (right.task.endedAt ?? 0));
		for (const record of history.slice(0, Math.max(0, history.length - this.maxHistory))) {
			this.records.delete(record.task.id);
			this.cleanupOutput(record);
		}
	}

	private emit(): void {
		if (this.closed) return;
		for (const listener of [...this.listeners]) {
			if (this.closed) break;
			try {
				listener();
			} catch {
				/* Observers do not own execution or delivery. */
			}
		}
	}
}
