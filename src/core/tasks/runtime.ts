import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Execution, type ExecutionHost, errorText } from "./execution.ts";
import { TASKS_WAIT_DEFAULT_MS, TASKS_WAIT_MAX_MS } from "./limits.ts";
import {
	boundFacts,
	boundInput,
	boundText,
	finiteLimit,
	readOutputSlice,
	sliceText,
	TASK_LABEL_BYTES,
	TASK_TITLE_BYTES,
} from "./output.ts";
import { TaskScheduler } from "./scheduler.ts";
import { snapshotOf, type TaskRecord, TaskStore } from "./store.ts";
import {
	TASK_BACKGROUND_REJECTION,
	TASK_KIND_PATTERN,
	type TaskExecution,
	TaskLookupError,
	type TaskRead,
	type TaskRuntimeOptions,
	type TaskSnapshot,
	type TasksContext,
	type TaskToolOutcome,
} from "./types.ts";

/** Session-local supervision. Executors own their processes, items and output files. */
export class TaskRuntime implements TasksContext {
	private readonly store: TaskStore;
	private readonly executions = new Map<string, Execution<unknown>>();
	private readonly scheduler = new TaskScheduler();
	private readonly listeners = new Set<() => void>();
	private readonly host: ExecutionHost;
	private readonly maxBackground: number;
	private readonly maxHistory: number;
	private readonly maxRetained: number;
	private readonly options: TaskRuntimeOptions;
	private configuredEnabled: boolean;
	private _closed = false;
	private pauses = 0;

	constructor(options: TaskRuntimeOptions = {}) {
		this.options = options;
		this.configuredEnabled = options.enabled ?? false;
		this.maxBackground = Math.max(1, finiteLimit(options.maxBackground, 8, 128));
		this.maxHistory = finiteLimit(options.maxHistory, 32, 1024);
		// Separate foreground and background histories, plus the protected-record allowance.
		this.maxRetained = this.maxBackground + 2 * Math.max(1, this.maxHistory) + this.maxHistory;
		this.store = new TaskStore(this.maxHistory, this.maxRetained, () => this.closed, options.onCleanupError);
		const runtime = this;
		this.host = {
			get closed() {
				return runtime.closed;
			},
			emit: () => this.emit(),
			settle: (task, usage) => this.options.onSettled?.(task, usage),
			released: (execution) => {
				this.executions.delete(execution.task.id);
				this.scheduler.release(execution);
				this.store.trim();
				this.emit();
			},
		};
	}

	get closed(): boolean {
		return this._closed;
	}

	get session(): TaskRuntimeOptions["session"] {
		return this.options.session;
	}

	/**
	 * Rehydrate terminal snapshots only, newest endedAt in each history (later input wins
	 * ties). Existing runtime records win ID collisions. No execution, accounting,
	 * notification, or deletion ownership is restored. Foreground records take their output
	 * from the branch's tool results. The host supplies the current branch; closed services
	 * ignore restoration.
	 */
	restoreHistory(
		records: readonly unknown[],
		toolResults?: ReadonlyMap<string, AgentToolResult<unknown>["content"]>,
	): void {
		this.store.restoreHistory(records, toolResults);
	}

	get enabled(): boolean {
		return this.configuredEnabled && !this.closed && this.options.backgroundAllowed !== false;
	}

	setEnabled(enabled: boolean): void {
		this.configuredEnabled = enabled;
		this.emit();
	}

	/** Foreground work is bounded by its caller; only background work, queued or running, holds a slot. */
	private backgroundActive(): number {
		let count = 0;
		for (const record of this.store.records.values())
			if (!record.settled && record.task.mode === "background") count++;
		return count;
	}

	private limitError(): Error {
		return new Error(
			`Background task limit reached (${this.maxBackground}); stop or wait for a background task, or run in the foreground.`,
		);
	}

	async execute<T>(execution: TaskExecution<T>): Promise<TaskToolOutcome<T>> {
		// Admission and registration happen synchronously, before invoking user code or awaiting anything.
		if (execution.background && this.options.backgroundAllowed === false) throw new Error(TASK_BACKGROUND_REJECTION);
		if (this.closed) throw new Error("Task service is closed");
		if (execution.background) {
			if (!this.enabled) throw new Error("Background execution is not available in this host");
			if (this.backgroundActive() >= this.maxBackground) throw this.limitError();
			if (this.store.records.size + this.store.cleanups.size >= this.maxRetained) {
				throw new Error(
					"Task history retention limit reached; deliver pending notifications or release pinned or claimed records",
				);
			}
		}
		if (execution.signal?.aborted) throw execution.signal.reason ?? new Error("Execution aborted");
		if (!TASK_KIND_PATTERN.test(execution.kind)) throw new Error("Invalid task source");
		const concurrency = execution.concurrency;
		if (concurrency && (!concurrency.key || !Number.isSafeInteger(concurrency.limit) || concurrency.limit < 1))
			throw new Error("Invalid task concurrency");
		const anchorId = this.options.anchor?.() ?? null;
		if (anchorId !== null && Buffer.byteLength(anchorId) > 8192) throw new Error("Task branch anchor is too large");
		const task: TaskSnapshot = {
			id: `${execution.kind}-${randomUUID()}`,
			kind: execution.kind,
			label: boundText(execution.label ?? execution.kind, TASK_LABEL_BYTES),
			title: boundText(execution.title, TASK_TITLE_BYTES),
			output: execution.output ?? "log",
			...(execution.input ? { input: boundInput(execution.input) } : {}),
			...(execution.facts?.length ? { facts: boundFacts(execution.facts) } : {}),
			toolCallId: boundText(execution.toolCallId, 512),
			anchorId,
			mode: execution.background ? "background" : "foreground",
			status: "queued",
			startedAt: Date.now(),
		};
		const record: TaskRecord = {
			task,
			settled: false,
			visible: true,
			delivery: "none",
			pins: 0,
			deliveryHolds: 0,
			waiters: new Set(),
		};
		const active = new Execution(this.host, record, execution);
		this.store.records.set(task.id, record);
		this.executions.set(task.id, active as Execution<unknown>);
		this.scheduler.schedule(active);
		// Queued background work returns at once; started work hands off after its own accept().
		if (active.queued) active.handoff();
		this.emit();
		return active.caller;
	}

	private detachable(record: TaskRecord): boolean {
		return this.executions.get(record.task.id)?.detachable ?? false;
	}

	detachForeground(): number {
		if (!this.enabled) return 0;
		const eligible = [...this.store.records.values()]
			.filter((record) => this.detachable(record))
			.sort((left, right) => left.task.startedAt - right.task.startedAt);
		if (!eligible.length) return 0;
		const free = this.maxBackground - this.backgroundActive();
		if (free <= 0) throw this.limitError();
		const executions = eligible.slice(0, free).map((record) => this.executions.get(record.task.id)!);
		for (const execution of executions) execution.requestDetach();
		for (const execution of executions) execution.completeDetach();
		this.emit();
		return executions.length;
	}

	canDetach(id: string): boolean {
		const record = this.lookup(id);
		return this.enabled && this.backgroundActive() < this.maxBackground && this.detachable(record);
	}

	detach(id: string): boolean {
		const record = this.lookup(id);
		if (!this.enabled || !this.detachable(record)) return false;
		if (this.backgroundActive() >= this.maxBackground) throw this.limitError();
		const execution = this.executions.get(record.task.id)!;
		execution.requestDetach();
		execution.completeDetach();
		this.emit();
		return true;
	}

	list(): TaskSnapshot[] {
		return [...this.store.records.values()].filter((record) => record.visible).map(snapshotOf);
	}

	private lookup(id: string): TaskRecord {
		const exact = this.store.records.get(id);
		if (exact) return exact;
		const matches = [...this.store.records.values()].filter(
			({ task }) => task.id.startsWith(id) || task.id.slice(task.kind.length + 1).startsWith(id),
		);
		if (!id || matches.length !== 1) {
			throw new TaskLookupError(matches.length > 1 ? "ambiguous" : "unknown", matches.map(snapshotOf));
		}
		return matches[0]!;
	}

	get(id: string): TaskSnapshot {
		return snapshotOf(this.lookup(id));
	}

	async read(
		id: string,
		options: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number } = {},
	): Promise<TaskRead> {
		const record = this.lookup(id);
		const release = this.retain(record.task.id);
		try {
			const task = snapshotOf(record);
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
		return task.result?.text || task.error || "No output yet.";
	}

	/** One event-driven waiter can observe a whole waitAny cohort without per-task timers. */
	private waitForRecords(
		records: readonly TaskRecord[],
		timeoutMs: number,
		signal?: AbortSignal,
		interruptSignal?: AbortSignal,
	): Promise<void> {
		if (records.some((record) => record.settled) || interruptSignal?.aborted) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const complete = (aborted = false) => {
				if (finished) return;
				finished = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				interruptSignal?.removeEventListener("abort", interrupt);
				for (const record of records) record.waiters.delete(wake);
				if (aborted) reject(signal?.reason ?? new Error("Wait aborted"));
				else resolve();
				this.store.trim();
				this.emit();
			};
			const wake = () => complete();
			const abort = () => complete(true);
			const interrupt = () => complete();
			for (const record of records) record.waiters.add(wake);
			signal?.addEventListener("abort", abort, { once: true });
			interruptSignal?.addEventListener("abort", interrupt, { once: true });
			timer = setTimeout(wake, finiteLimit(timeoutMs, TASKS_WAIT_DEFAULT_MS, TASKS_WAIT_MAX_MS));
			if (this.closed || interruptSignal?.aborted) wake();
			if (signal?.aborted) abort();
		});
	}

	/** Observe completion without consuming delivery; the host acknowledges only persisted tool results. */
	async wait(
		id: string,
		timeoutMs = TASKS_WAIT_DEFAULT_MS,
		signal?: AbortSignal,
		interruptSignal?: AbortSignal,
	): Promise<TaskSnapshot> {
		if (signal?.aborted) throw signal.reason ?? new Error("Wait aborted");
		const record = this.lookup(id);
		if (record.settled) return snapshotOf(record);
		await this.waitForRecords([record], timeoutMs, signal, interruptSignal);
		return snapshotOf(record);
	}

	async waitAny(
		timeoutMs = TASKS_WAIT_DEFAULT_MS,
		signal?: AbortSignal,
		interruptSignal?: AbortSignal,
	): Promise<TaskSnapshot | undefined> {
		if (signal?.aborted) throw signal.reason ?? new Error("Wait aborted");
		const records = [...this.store.records.values()].filter(
			(record) => record.visible && record.task.mode === "background" && !record.settled,
		);
		if (records.length === 0 || interruptSignal?.aborted) return undefined;
		await this.waitForRecords(records, timeoutMs, signal, interruptSignal);
		const settled = records
			.filter((record) => record.settled)
			.sort((left, right) => (left.task.endedAt ?? 0) - (right.task.endedAt ?? 0))[0];
		return settled ? snapshotOf(settled) : undefined;
	}

	kill(id: string): boolean {
		return this.cancel(this.lookup(id));
	}

	private cancel(record: TaskRecord): boolean {
		return this.executions.get(record.task.id)?.cancel() ?? false;
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
		return [...this.store.records.values()].filter((record) => this.candidate(record)).map(snapshotOf);
	}

	/** Only explicit result-delivery holds delay an automatic completion. */
	private candidate(record: TaskRecord): boolean {
		return record.visible && record.delivery === "pending" && record.waiters.size === 0 && record.deliveryHolds === 0;
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
			this.executions.get(record.task.id)?.releaseParent();
			this.cancel(record);
			for (const waiter of [...record.waiters]) waiter();
		}
		this.store.trim();
	}

	async shutdown(graceMs = 2000): Promise<void> {
		this.close();
		await this.drain([...this.store.records.values()], graceMs);
	}

	/** Running tasks whose launch anchor is outside the branch made of `ancestors`. */
	activeOutsideBranch(ancestors: ReadonlySet<string>): TaskSnapshot[] {
		return [...this.store.records.values()]
			.filter((record) => !record.settled && record.task.anchorId !== null && !ancestors.has(record.task.anchorId))
			.map(snapshotOf);
	}

	/**
	 * Hidden results stay pending: returning to their branch delivers them again.
	 * Restored history is already delivered.
	 */
	async cancelOutsideBranch(ancestors: ReadonlySet<string>): Promise<void> {
		for (const record of this.store.records.values())
			record.visible = record.task.anchorId === null || ancestors.has(record.task.anchorId);
		const outside = [...this.store.records.values()].filter((record) => !record.visible);
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
