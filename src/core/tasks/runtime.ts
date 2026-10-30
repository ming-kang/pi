import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { finiteLimit } from "../../utils/number.ts";
import { Execution, type ExecutionHost } from "./execution.ts";
import { boundWaitMs, TASKS_WAIT_DEFAULT_MS } from "./limits.ts";
import {
	boundFacts,
	boundInput,
	boundText,
	errorText,
	readOutputSlice,
	sliceText,
	TASK_LABEL_BYTES,
	TASK_TITLE_BYTES,
} from "./output.ts";
import { TaskRecord } from "./record.ts";
import { TaskScheduler } from "./scheduler.ts";
import { TaskStore } from "./store.ts";
import {
	TASK_BACKGROUND_REJECTION,
	TASK_KIND_PATTERN,
	type TaskDeliveryLedger,
	type TaskExecution,
	TaskLookupError,
	type TaskRead,
	type TaskReadOptions,
	type TaskRuntimeOptions,
	type TaskSnapshot,
	type TasksContext,
	type TaskToolOutcome,
	type TaskWaitAnyOptions,
	type TaskWaitAnyResult,
	type TaskWaitOptions,
	type TaskWaitOutcome,
	type TaskWaitResult,
} from "./types.ts";

/** Session-local supervision. Executors own their processes, items and output files. */
export class TaskRuntime implements TasksContext, TaskDeliveryLedger {
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
	private activeBackground(): TaskRecord[] {
		return this.store.unsettled().filter((record) => record.task.mode === "background");
	}

	private backgroundActive(): number {
		return this.activeBackground().length;
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
			if (this.store.retainedCount() >= this.maxRetained) {
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
		const record = new TaskRecord(task);
		const active = new Execution(this.host, record, execution);
		this.store.add(record);
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
		const eligible = [...this.executions.values()]
			.filter((execution) => execution.detachable)
			.sort((left, right) => left.task.startedAt - right.task.startedAt);
		if (!eligible.length) return 0;
		const free = this.maxBackground - this.backgroundActive();
		if (free <= 0) throw this.limitError();
		const executions = eligible.slice(0, free);
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
		return this.store.visible().map((record) => record.snapshot());
	}

	private lookup(id: string): TaskRecord {
		const exact = this.store.get(id);
		if (exact) return exact;
		const matches = this.store.match(id);
		if (!id || matches.length !== 1) {
			throw new TaskLookupError(
				matches.length > 1 ? "ambiguous" : "unknown",
				matches.map((record) => record.snapshot()),
			);
		}
		return matches[0]!;
	}

	get(id: string): TaskSnapshot {
		return this.lookup(id).snapshot();
	}

	async read(id: string, options: TaskReadOptions = {}): Promise<TaskRead> {
		const record = this.lookup(id);
		const release = this.retain(record.task.id);
		try {
			const task = record.snapshot();
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
			timer = setTimeout(wake, boundWaitMs(timeoutMs));
			if (this.closed || interruptSignal?.aborted) wake();
			if (signal?.aborted) abort();
		});
	}

	/**
	 * One observation: hold delivery for the observed records, wait, read, then register the
	 * receipt with the host, and only then release. Nothing the caller does between those steps
	 * can leak a settled result into an automatic notification or lose it.
	 */
	private async observe(
		records: readonly TaskRecord[],
		options: TaskWaitOptions,
		/** Record to read when none settled; a cohort has none. */
		fallback?: TaskRecord,
	): Promise<{
		outcome: TaskWaitOutcome;
		waitedMs: number;
		settled?: TaskRecord;
		running: TaskSnapshot[];
		read?: TaskRead;
	}> {
		const { signal } = options;
		const releases = records.map((record) => this.holdRecord(record));
		try {
			const start = Date.now();
			const interrupt = this.options.waits?.interruptSignal;
			await this.waitForRecords(records, options.timeoutMs ?? TASKS_WAIT_DEFAULT_MS, signal, interrupt);
			const waitedMs = Date.now() - start;
			const settled = records
				.filter((record) => record.settled)
				.sort((left, right) => (left.task.endedAt ?? 0) - (right.task.endedAt ?? 0))[0];
			const outcome: TaskWaitOutcome = settled
				? "settled"
				: this.closed
					? "closed"
					: interrupt?.aborted
						? "interrupted"
						: "timed_out";
			const running = records
				.filter((record) => record.visible && !record.settled)
				.map((record) => record.snapshot());
			const observed = settled ?? fallback;
			const read =
				options.read && observed && outcome !== "interrupted"
					? await this.read(observed.task.id, options.read)
					: undefined;
			signal?.throwIfAborted();
			if (settled && settled.task.mode === "background" && options.toolCallId)
				this.options.waits?.bind(options.toolCallId, settled.task.id);
			return { outcome, waitedMs, settled, running, read };
		} finally {
			for (const release of releases) release();
		}
	}

	async wait(id: string, options: TaskWaitOptions = {}): Promise<TaskWaitResult> {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Wait aborted");
		const record = this.lookup(id);
		const { outcome, waitedMs, read } = await this.observe([record], options, record);
		return { outcome, waitedMs, task: record.snapshot(), ...(read ? { read } : {}) };
	}

	async waitAny(options: TaskWaitAnyOptions = {}): Promise<TaskWaitAnyResult> {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Wait aborted");
		const records = this.activeBackground().filter((record) => record.visible);
		if (records.length === 0) return { outcome: "no_tasks", waitedMs: 0, running: [] };
		const { outcome, waitedMs, settled, running, read } = await this.observe(records, options);
		return {
			outcome,
			waitedMs,
			running,
			...(settled ? { task: settled.snapshot() } : {}),
			...(read ? { read } : {}),
		};
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
		return this.pin(this.lookup(id));
	}

	private pin(record: TaskRecord): () => void {
		record.pins++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			record.pins--;
			this.store.trim();
			// Listeners decide whether delivery may proceed; TaskDelivery owns pausing.
			if (!this.closed && record.deliverable) this.emit();
		};
	}

	holdDelivery(id: string): () => void {
		return this.holdRecord(this.lookup(id));
	}

	private holdRecord(record: TaskRecord): () => void {
		const releasePin = this.pin(record);
		record.deliveryHolds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			record.deliveryHolds--;
			releasePin();
		};
	}

	pendingNotifications(): TaskSnapshot[] {
		if (this.closed) return [];
		return this.store.deliverable().map((record) => record.snapshot());
	}

	claimNotification(id: string): boolean {
		return !this.closed && (this.store.get(id)?.claim() ?? false);
	}

	markDelivered(id: string): void {
		const record = this.store.get(id);
		if (!record) return;
		record.acknowledge();
		this.store.trim();
	}

	releaseNotification(id: string): void {
		if (!this.store.get(id)?.unclaim()) return;
		this.store.trim();
		this.emit();
	}

	close(): void {
		if (this.closed) return;
		this._closed = true;
		this.listeners.clear();
		for (const record of this.store.all()) {
			this.executions.get(record.task.id)?.releaseParent();
			this.cancel(record);
			for (const waiter of [...record.waiters]) waiter();
		}
		this.store.trim();
	}

	async shutdown(graceMs = 2000): Promise<void> {
		this.close();
		await this.drain(this.store.all(), graceMs);
	}

	/** Running tasks whose launch anchor is outside the branch made of `ancestors`. */
	activeOutsideBranch(ancestors: ReadonlySet<string>): TaskSnapshot[] {
		return this.store
			.unsettled()
			.filter((record) => record.task.anchorId !== null && !ancestors.has(record.task.anchorId))
			.map((record) => record.snapshot());
	}

	/**
	 * Hidden results stay pending: returning to their branch delivers them again.
	 * Restored history is already delivered.
	 */
	async cancelOutsideBranch(ancestors: ReadonlySet<string>): Promise<void> {
		const records = this.store.all();
		for (const record of records)
			record.visible = record.task.anchorId === null || ancestors.has(record.task.anchorId);
		const outside = records.filter((record) => !record.visible);
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
					this.store.cleanupsDone(),
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
