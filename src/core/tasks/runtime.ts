import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { finiteLimit } from "../../utils/number.ts";
import { Execution, type ExecutionHost } from "./execution.ts";
import { defaultReadMode } from "./limits.ts";
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
	TASK_MANAGEMENT_REJECTION,
	type TaskExecution,
	TaskLookupError,
	type TaskRead,
	type TaskReadOptions,
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

	/** Tell subscribers that something the runtime reads from its host changed, such as `canManageBackground`. */
	refresh(): void {
		this.emit();
	}

	/** Whether new work may move to or start in the background: enabled, and the host can manage it. */
	private get admitsBackground(): boolean {
		return this.enabled && (this.options.canManageBackground?.() ?? true);
	}

	/**
	 * Foreground work is bounded by its caller; only background work holds a slot, including work
	 * whose caller is still waiting for the executor to accept (a detaching task).
	 */
	private backgroundActive(): number {
		return [...this.executions.values()].filter((execution) => execution.holdsBackgroundSlot).length;
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
			if (!this.admitsBackground) throw new Error(TASK_MANAGEMENT_REJECTION);
			if (this.backgroundActive() >= this.maxBackground) throw this.limitError();
			if (this.store.retainedCount() >= this.maxRetained) {
				throw new Error(
					"Task history retention limit reached; deliver pending notifications or release task pins and delivery leases",
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
			mode: "foreground",
			status: "queued",
			startedAt: Date.now(),
		};
		const record = new TaskRecord(task);
		const active = new Execution(this.host, record, execution);
		this.store.add(record);
		this.executions.set(task.id, active as Execution<unknown>);
		this.scheduler.schedule(active);
		// Queued background work returns at once; started work hands off after its own accept().
		active.handOffIfQueued();
		this.emit();
		return active.caller;
	}

	private detachable(record: TaskRecord): boolean {
		return this.executions.get(record.task.id)?.detachable ?? false;
	}

	detachForeground(): number {
		if (!this.admitsBackground) return 0;
		const eligible = [...this.executions.values()]
			.filter((execution) => execution.detachable)
			.sort((left, right) => left.task.startedAt - right.task.startedAt);
		if (!eligible.length) return 0;
		const free = this.maxBackground - this.backgroundActive();
		if (free <= 0) throw this.limitError();
		return this.detachAll(eligible.slice(0, free));
	}

	canDetach(id: string): boolean {
		const record = this.lookup(id);
		return this.admitsBackground && this.backgroundActive() < this.maxBackground && this.detachable(record);
	}

	detach(id: string): boolean {
		const record = this.lookup(id);
		if (!this.admitsBackground || !this.detachable(record)) return false;
		if (this.backgroundActive() >= this.maxBackground) throw this.limitError();
		this.detachAll([this.executions.get(record.task.id)!]);
		return true;
	}

	/** Every placement changes before any listener hears about it. */
	private detachAll(executions: Execution<unknown>[]): number {
		const notifications = executions.map((execution) => execution.detach());
		for (const notify of notifications) notify();
		this.emit();
		return executions.length;
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
			const window = { ...options, mode: options.mode ?? defaultReadMode(task) };
			if (task.outputPath) {
				try {
					return { task, ...(await readOutputSlice(task.outputPath, window)) };
				} catch (error) {
					return {
						task,
						readError: boundText(`Output could not be read: ${errorText(error)}`, 4096),
						...sliceText(this.resultText(task), window),
					};
				}
			}
			return { task, readError: record.readError, ...sliceText(this.resultText(task), window) };
		} finally {
			release();
		}
	}

	private resultText(task: TaskSnapshot): string {
		return task.result?.text || task.error || "No output yet.";
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

	/** Retention protects snapshots and logs only; completion delivery never waits on it. */
	retain(id: string): () => void {
		return this.pin(this.lookup(id));
	}

	private pin(record: TaskRecord): () => void {
		const release = record.pin();
		return () => {
			release();
			this.store.trim();
		};
	}

	close(): void {
		if (this.closed) return;
		this._closed = true;
		this.listeners.clear();
		for (const record of this.store.all()) {
			this.executions.get(record.task.id)?.releaseParent();
			this.cancel(record);
		}
		this.options.onClosed?.();
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
			record.setVisible(record.task.anchorId === null || ancestors.has(record.task.anchorId));
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
