import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { boundedResult, boundText, finiteLimit, readOutputSlice, sliceText, TASK_TITLE_BYTES } from "./output.ts";
import { readTaskProjection } from "./presentation.ts";
import { type TaskRecord, TaskStore } from "./store.ts";
import {
	TASK_BACKGROUND_REJECTION,
	type TaskCompletion,
	type TaskControl,
	type TaskExecution,
	TaskExecutionError,
	TaskLookupError,
	type TaskMode,
	type TaskRead,
	type TaskRuntimeOptions,
	type TaskSnapshot,
	type TasksContext,
	type TaskToolOutcome,
} from "./types.ts";

interface ActiveTask {
	controller: AbortController;
	accepted: boolean;
	handedOff: boolean;
	detachRequested: boolean;
	publishedUsage?: Usage;
	modeListeners: Set<(mode: TaskMode) => void>;
	removeParent(): void;
	handoff(): void;
	done: Promise<void>;
}

function errorText(error: unknown): string {
	try {
		return boundText(error instanceof Error ? error.message : String(error), 4096);
	} catch {
		return "Background execution failed (unprintable error)";
	}
}

function storeResult(task: TaskSnapshot, result: AgentToolResult<unknown>, truncated = false): void {
	const bounded = boundedResult({ content: result.content, details: undefined });
	task.result = bounded;
	task.resultTruncated =
		truncated ||
		bounded.content.length !== result.content.length ||
		bounded.content.some((block, index) => {
			const original = result.content[index];
			return original?.type !== "text" || block.type !== "text" || block.text !== original.text;
		});
}

/** Session-local supervision. Executors own their processes, items and output files. */
export class TaskRuntime implements TasksContext {
	private readonly store: TaskStore;
	private readonly executions = new Map<string, ActiveTask>();
	private readonly listeners = new Set<() => void>();
	private readonly maxActive: number;
	private readonly maxHistory: number;
	private readonly maxRetained: number;
	private configuredEnabled: boolean;
	private _closed = false;

	get closed(): boolean {
		return this._closed;
	}
	private pauses = 0;

	private readonly options: TaskRuntimeOptions;

	constructor(options: TaskRuntimeOptions = {}) {
		this.options = options;
		this.configuredEnabled = options.enabled ?? false;
		this.maxActive = Math.max(1, finiteLimit(options.maxActive, 8, 128));
		this.maxHistory = finiteLimit(options.maxHistory, 32, 1024);
		// Separate foreground shell history, plus the existing history/protected-record allowance.
		this.maxRetained = this.maxActive + 2 * Math.max(1, this.maxHistory) + this.maxHistory;
		this.store = new TaskStore(this.maxHistory, this.maxRetained, () => this.closed, options.onCleanupError);
	}

	/**
	 * Rehydrate terminal version-2 custom data only, newest endedAt in each history
	 * (later input wins ties). Existing runtime records win ID collisions. No execution, accounting,
	 * notification, or deletion ownership is restored, including for worker projections.
	 * The host supplies the current branch; closed services ignore restoration.
	 */
	restoreHistory(records: readonly unknown[]): void {
		this.store.restoreHistory(records);
	}

	get enabled(): boolean {
		return this.configuredEnabled && !this.closed && this.options.backgroundAllowed !== false;
	}

	setEnabled(enabled: boolean): void {
		this.configuredEnabled = enabled;
		this.emit();
	}

	async execute<T>(execution: TaskExecution<T>): Promise<TaskToolOutcome<T>> {
		// Admission and registration happen synchronously, before invoking user code or awaiting anything.
		if (execution.background && this.options.backgroundAllowed === false) throw new Error(TASK_BACKGROUND_REJECTION);
		if (this.closed) throw new Error("Background service is closed");
		if (execution.background && !this.enabled) throw new Error("Background execution is not available in this host");
		if (execution.signal?.aborted) throw execution.signal.reason ?? new Error("Execution aborted");
		if ([...this.store.records.values()].filter((record) => !record.settled).length >= this.maxActive) {
			throw new Error(`Background execution limit reached (${this.maxActive})`);
		}
		if (this.store.records.size + this.store.cleanups.size >= this.maxRetained) {
			throw new Error(
				"Background history retention limit reached; deliver pending notifications or release pinned or claimed records",
			);
		}
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(execution.kind)) throw new Error("Invalid task source");
		const anchorId = this.options.anchor?.() ?? null;
		if (anchorId !== null && Buffer.byteLength(anchorId) > 8192)
			throw new Error("Background branch anchor is too large");
		const task: TaskSnapshot = {
			id: `${execution.kind}-${randomUUID()}`,
			kind: execution.kind,
			format: execution.format ?? "report",
			title: boundText(execution.title, TASK_TITLE_BYTES),
			toolCallId: boundText(execution.toolCallId, 512),
			anchorId,
			mode: execution.background ? "background" : "foreground",
			status: "queued",
			startedAt: Date.now(),
			command: execution.command === undefined ? undefined : boundText(execution.command, 8192),
			commandTruncated:
				execution.command === undefined ? undefined : boundText(execution.command, 8192) !== execution.command,
			cwd: execution.cwd === undefined ? undefined : boundText(execution.cwd, 4096),
		};
		let resolveCaller!: (outcome: TaskToolOutcome<T>) => void;
		let rejectCaller!: (error: unknown) => void;
		const caller = new Promise<TaskToolOutcome<T>>((resolve, reject) => {
			resolveCaller = resolve;
			rejectCaller = reject;
		});
		let resolveDone!: () => void;
		const record: TaskRecord = {
			task,
			settled: false,
			accounted: false,
			visible: true,
			suppressed: false,
			delivery: "pending",
			pins: 0,
			deliveryHolds: 0,
			waiters: new Set(),
		};
		const active: ActiveTask = {
			controller: new AbortController(),
			accepted: false,
			handedOff: false,
			detachRequested: execution.background ?? false,
			modeListeners: new Set(),
			removeParent: () => {},
			handoff: () => {
				if (
					!active.accepted ||
					!active.detachRequested ||
					record.settled ||
					active.handedOff ||
					this.closed ||
					record.suppressed ||
					active.controller.signal.aborted
				)
					return;
				active.handedOff = true;
				record.handedOff = true;
				task.mode = "background";
				active.removeParent();
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
			if (!active.detachRequested || !active.accepted) this.cancel(record);
		};
		parentSignal?.addEventListener("abort", parentAbort, { once: true });
		active.removeParent = () => {
			parentSignal?.removeEventListener("abort", parentAbort);
			onUpdate = undefined;
		};
		this.store.records.set(task.id, record);
		this.executions.set(task.id, active);
		const control: TaskControl<T> = {
			id: task.id,
			signal: active.controller.signal,
			get mode() {
				return task.mode;
			},
			onModeChange: (listener) => {
				if (record.settled || this.closed) return () => {};
				active.modeListeners.add(listener);
				return () => {
					active.modeListeners.delete(listener);
				};
			},
			requestCancel: () => this.cancel(record),
			accept: () => {
				if (record.settled || active.accepted || this.closed || active.controller.signal.aborted) return;
				active.accepted = true;
				if (task.status === "queued") task.status = "running";
				if (active.detachRequested) active.removeParent();
				// Let an already available final result win over a handoff.
				queueMicrotask(() => queueMicrotask(active.handoff));
				this.emit();
			},
			publish: (result, projection) => {
				if (record.settled || this.closed) return;
				storeResult(task, result);
				if (result.usage !== undefined) active.publishedUsage = structuredClone(result.usage);
				if (projection) task.projection = readTaskProjection(projection);
				if (!active.detachRequested && !active.handedOff) {
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
				// Never truncate a real filesystem path into a different path.
				if (Buffer.byteLength(path) > 8192) throw new Error("Background output path is too large");
				record.cleanup = cleanup;
				task.outputPath = path;
				this.emit();
			},
		};
		const finish = (completion: TaskCompletion<T> | undefined, error?: unknown) => {
			if (record.settled) return;
			record.settled = true;
			active.modeListeners.clear();
			active.removeParent();
			task.endedAt = Date.now();
			const failed = completion === undefined;
			task.status =
				completion?.status ??
				(error instanceof TaskExecutionError
					? error.status
					: active.controller.signal.aborted
						? "cancelled"
						: failed
							? "failed"
							: "completed");
			if (completion) {
				storeResult(task, completion.result);
				if (completion.error !== undefined) task.error = boundText(completion.error, 4096);
				if (completion.exitCode !== undefined) task.exitCode = completion.exitCode;
			}
			if (failed) {
				task.error = errorText(error);
				storeResult(
					task,
					{
						content: [{ type: "text", text: task.error }, ...(task.result?.content ?? [])],
						details: task.result?.details,
					},
					task.resultTruncated,
				);
			}
			let settlementWarning: string | undefined;
			try {
				this.options.onSettled?.(
					this.snapshot(record),
					completion?.usage ?? completion?.result.usage ?? active.publishedUsage,
				);
			} catch (accountingError) {
				const warning = `Usage settlement failed: ${errorText(accountingError)}`;
				settlementWarning = warning;
				task.error = boundText([task.error, warning].filter(Boolean).join("\n"), 8192);
				storeResult(
					task,
					{
						content: [{ type: "text", text: warning }, ...(task.result?.content ?? [])],
						details: task.result?.details,
					},
					task.resultTruncated,
				);
			}
			active.publishedUsage = undefined;
			record.accounted = true;
			if (!active.handedOff) {
				record.delivery = "delivered";
				if (failed) rejectCaller(error);
				else {
					const { usage: _usage, ...result } = completion.result;
					if (settlementWarning) result.content = [{ type: "text", text: settlementWarning }, ...result.content];
					resolveCaller({ kind: "result", result, status: task.status, error: task.error });
				}
			}
			for (const waiter of [...record.waiters]) waiter();
			resolveDone();
			this.executions.delete(task.id);
			this.store.trim();
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
		const records = [...this.store.records.values()].filter((record) => {
			const active = this.executions.get(record.task.id);
			return active && !record.settled && !active.detachRequested && !active.controller.signal.aborted;
		});
		for (const record of records) this.prepareDetach(record);
		for (const record of records) this.finishDetach(record);
		if (records.length) this.emit();
		return records.length;
	}

	detach(id: string): boolean {
		const record = this.lookup(id);
		const active = this.executions.get(record.task.id);
		if (!this.enabled || !active || record.settled || active.detachRequested || active.controller.signal.aborted)
			return false;
		this.prepareDetach(record);
		this.finishDetach(record);
		this.emit();
		return true;
	}

	private prepareDetach(record: TaskRecord): void {
		const active = this.executions.get(record.task.id)!;
		active.detachRequested = true;
		record.task.mode = "background";
		if (active.accepted) active.removeParent();
	}

	private finishDetach(record: TaskRecord): void {
		const active = this.executions.get(record.task.id)!;
		active.handoff();
		for (const listener of active.modeListeners) {
			try {
				listener(record.task.mode);
			} catch {
				/* Executors own their diagnostics. */
			}
		}
	}

	list(): TaskSnapshot[] {
		return [...this.store.records.values()].filter((record) => record.visible).map((record) => this.snapshot(record));
	}

	private lookup(id: string): TaskRecord {
		const exact = this.store.records.get(id);
		if (exact) return exact;
		const matches = [...this.store.records.values()].filter(
			({ task }) => task.id.startsWith(id) || task.id.slice(task.kind.length + 1).startsWith(id),
		);
		if (!id || matches.length !== 1) {
			throw new TaskLookupError(
				matches.length > 1 ? "ambiguous" : "unknown",
				matches.map((record) => this.snapshot(record)),
			);
		}
		return matches[0]!;
	}

	get(id: string): TaskSnapshot {
		return this.snapshot(this.lookup(id));
	}

	async read(
		id: string,
		options: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number } = {},
	): Promise<TaskRead> {
		const record = this.lookup(id);
		const release = this.retain(record.task.id);
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

	private resultText(task: TaskSnapshot): string {
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
	async wait(id: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<TaskSnapshot> {
		if (signal?.aborted) throw signal.reason ?? new Error("Wait aborted");
		const record = this.lookup(id);
		if (record.settled) return this.snapshot(record);
		return new Promise<TaskSnapshot>((resolve, reject) => {
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
				this.store.trim();
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

	private cancel(record: TaskRecord): boolean {
		const active = this.executions.get(record.task.id);
		if (!active || record.settled || active.controller.signal.aborted) return false;
		record.task.status = "stopping";
		active.controller.abort();
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

	/**
	 * Retention protects snapshots and logs only. Delivery has its own explicit hold.
	 */
	retain(id: string): () => void {
		const record = this.lookup(id);
		record.pins++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			record.pins--;
			this.store.trim();
			if (!this.closed && this.pauses === 0 && this.candidate(record)) this.emit();
		};
	}

	holdDelivery(id: string): () => void {
		const record = this.lookup(id);
		const releaseRetention = this.retain(id);
		record.deliveryHolds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			record.deliveryHolds--;
			releaseRetention();
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

	pendingNotifications(): TaskSnapshot[] {
		if (this.closed || this.pauses > 0) return [];
		return [...this.store.records.values()]
			.filter((record) => this.candidate(record))
			.map((record) => this.snapshot(record));
	}

	/**
	 * Only explicit result-delivery holds delay an automatic completion.
	 */
	private candidate(record: TaskRecord): boolean {
		return (
			record.visible &&
			record.settled &&
			record.accounted &&
			record.handedOff === true &&
			!record.suppressed &&
			record.delivery === "pending" &&
			record.waiters.size === 0 &&
			record.deliveryHolds === 0
		);
	}

	claimNotification(id: string): boolean {
		if (this.closed || this.pauses > 0) return false;
		const record = this.store.records.get(id);
		if (!record || !this.candidate(record)) return false;
		record.delivery = "claimed";
		return true;
	}

	markDelivered(id: string): void {
		const record = this.store.records.get(id);
		if (!record) return;
		record.delivery = "delivered";
		this.store.trim();
	}

	releaseNotification(id: string): void {
		const record = this.store.records.get(id);
		if (!record || record.delivery !== "claimed") return;
		record.delivery = "pending";
		this.store.trim();
		this.emit();
	}

	close(): void {
		if (this.closed) return;
		this._closed = true;
		this.listeners.clear();
		for (const record of this.store.records.values()) {
			record.suppressed = true;
			this.executions.get(record.task.id)?.removeParent();
			this.cancel(record);
			for (const waiter of [...record.waiters]) waiter();
		}
		this.store.trim();
	}

	async shutdown(graceMs = 2000): Promise<void> {
		this.close();
		await this.drain([...this.store.records.values()], graceMs);
	}

	async cancelOutsideBranch(ancestors: ReadonlySet<string>): Promise<void> {
		for (const record of this.store.records.values()) {
			record.visible = record.task.anchorId === null || ancestors.has(record.task.anchorId);
			// Returning to a branch revives its undelivered completions; restored history
			// stays delivered and suppressed.
			if (record.visible && record.delivery === "pending") record.suppressed = false;
		}
		const outside = [...this.store.records.values()].filter((record) => !record.visible);
		for (const record of outside) record.suppressed = true;
		for (const record of outside) this.cancel(record);
		this.store.trim();
		this.emit();
		await this.drain(outside, 2000);
	}

	private async drain(records: TaskRecord[], graceMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.all(records.map((record) => this.executions.get(record.task.id)?.done)).then(() =>
					Promise.all(this.store.cleanups),
				),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, finiteLimit(graceMs, 2000, 60_000));
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private snapshot(record: TaskRecord): TaskSnapshot {
		return structuredClone(record.task);
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
