import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import {
	boundFacts,
	boundTaskText,
	boundText,
	errorText,
	resultText,
	TASK_ERROR_BYTES,
	TASK_PATH_BYTES,
} from "./output.ts";
import type { TaskRecord } from "./record.ts";
import type {
	TaskCompletion,
	TaskControl,
	TaskExecution,
	TaskFact,
	TaskMode,
	TaskSnapshot,
	TaskTerminalStatus,
	TaskText,
	TaskToolOutcome,
	TaskUpdate,
} from "./types.ts";

/** The runtime services one execution needs; it never reaches into the runtime itself. */
export interface ExecutionHost {
	readonly closed: boolean;
	emit(): void;
	/** Synchronous persistence before terminal observers or notifications. */
	settle(task: TaskSnapshot, usage: Usage | undefined): void;
	/** The execution settled and holds no slot, parent listener or caller any more. */
	released(execution: Execution<unknown>): void;
}

function prependText(text: string, result: TaskText | undefined): TaskText {
	return {
		text: boundText(result?.text ? `${text}\n${result.text}` : text),
		truncated: result?.truncated ?? false,
	};
}

/** Terminal rows replace launch rows with the same label and append new ones. */
function mergeFacts(base: readonly TaskFact[] = [], terminal: readonly TaskFact[]): TaskFact[] {
	const labels = new Set(terminal.map(([label]) => label));
	return boundFacts([...base.filter(([label]) => !labels.has(label)), ...terminal]);
}

/**
 * One live task: its caller, controller, parent link and executor callbacks.
 *
 * A caller may be handed off to the background whenever no executor preflight is in
 * progress: before `run` starts (queued) or after the executor calls `accept()`.
 */
export class Execution<T> {
	readonly record: TaskRecord;
	readonly concurrency?: { key: string; limit: number };
	readonly caller: Promise<TaskToolOutcome<T>>;
	readonly done: Promise<void>;
	readonly control: TaskControl<T>;
	private readonly host: ExecutionHost;
	private readonly run: TaskExecution<T>["run"];
	private readonly controller = new AbortController();
	private readonly modeListeners = new Set<(mode: TaskMode) => void>();
	private resolveCaller!: (outcome: TaskToolOutcome<T>) => void;
	private rejectCaller!: (error: unknown) => void;
	private resolveDone!: () => void;
	private onUpdate?: (result: AgentToolResult<T>) => void;
	private releaseParentSignal: () => void = () => {};
	private usage?: Usage;
	private started = false;
	private accepted = false;
	private handedOff = false;
	private detachRequested: boolean;
	/** The executor's `run` promise once started. */
	private running?: Promise<TaskCompletion<T>>;

	constructor(host: ExecutionHost, record: TaskRecord, execution: TaskExecution<T>) {
		this.host = host;
		this.record = record;
		this.run = execution.run;
		this.concurrency = execution.concurrency;
		this.detachRequested = execution.background ?? false;
		this.onUpdate = execution.background ? undefined : execution.onUpdate;
		this.caller = new Promise<TaskToolOutcome<T>>((resolve, reject) => {
			this.resolveCaller = resolve;
			this.rejectCaller = reject;
		});
		this.done = new Promise<void>((resolve) => {
			this.resolveDone = resolve;
		});
		const parent = execution.signal;
		if (parent) {
			const abort = () => {
				if (!this.detachRequested || !this.handoffAllowed) this.cancel();
			};
			parent.addEventListener("abort", abort, { once: true });
			this.releaseParentSignal = () => parent.removeEventListener("abort", abort);
		}
		const task = record.task;
		this.control = {
			id: task.id,
			signal: this.controller.signal,
			get mode() {
				return task.mode;
			},
			onModeChange: (listener) => this.onModeChange(listener),
			accept: () => this.accept(),
			publish: (update) => this.publish(update),
			attachOutput: (path, cleanup) => this.attachOutput(path, cleanup),
			cancel: () => {
				this.cancel();
			},
		};
	}

	get task(): Readonly<TaskSnapshot> {
		return this.record.task;
	}

	get aborted(): boolean {
		return this.controller.signal.aborted;
	}

	/** Executor preflight never races a handoff; queued work has not begun any. */
	private get handoffAllowed(): boolean {
		return !this.started || this.accepted;
	}

	/** Waiting for a concurrency slot: registered, but `run` has not started. */
	get queued(): boolean {
		return !this.started && !this.record.settled;
	}

	get detachable(): boolean {
		return !this.record.settled && !this.detachRequested && !this.aborted;
	}

	/** Stop forwarding to the launching tool call: parent cancellation and progress no longer reach it. */
	releaseParent(): void {
		this.releaseParentSignal();
		this.releaseParentSignal = () => {};
		this.onUpdate = undefined;
	}

	start(): void {
		if (this.started || this.record.settled) return;
		if (this.host.closed) {
			this.cancel();
			return;
		}
		this.started = true;
		this.record.update((task) => {
			task.status = "running";
		});
		// The rejection handler is installed immediately, including for synchronous preflight throws.
		try {
			this.running = Promise.resolve(this.run(this.control));
			void this.running.then(
				(completion) => this.finish(completion),
				(error: unknown) => this.finish(undefined, error),
			);
		} catch (error) {
			this.finish(undefined, error);
		}
	}

	handoff(): void {
		if (
			!this.handoffAllowed ||
			!this.detachRequested ||
			this.record.settled ||
			this.handedOff ||
			this.host.closed ||
			!this.record.visible ||
			this.aborted
		)
			return;
		this.handedOff = true;
		this.record.update((task) => {
			task.mode = "background";
		});
		this.releaseParent();
		this.resolveCaller({ kind: "background", task: this.record.snapshot() });
		this.host.emit();
	}

	requestDetach(): void {
		this.detachRequested = true;
		this.record.update((task) => {
			task.mode = "background";
		});
		if (this.accepted) this.releaseParent();
	}

	completeDetach(): void {
		this.handoff();
		for (const listener of this.modeListeners) {
			try {
				listener(this.task.mode);
			} catch {
				/* Executors own their diagnostics. */
			}
		}
	}

	cancel(): boolean {
		if (this.record.settled || this.aborted) return false;
		this.record.update((task) => {
			task.status = "stopping";
		});
		this.controller.abort();
		if (!this.started) this.finish(undefined, new Error("Task cancelled before it started."));
		this.host.emit();
		return true;
	}

	private onModeChange(listener: (mode: TaskMode) => void): () => void {
		if (this.record.settled || this.host.closed) return () => {};
		this.modeListeners.add(listener);
		return () => {
			this.modeListeners.delete(listener);
		};
	}

	private accept(): void {
		if (this.record.settled || this.accepted || this.host.closed || this.aborted) return;
		this.accepted = true;
		if (this.detachRequested) this.releaseParent();
		// An already available final result wins over a handoff, so decide only once the
		// executor's own synchronous code has yielded.
		queueMicrotask(() => this.handoffIfRunning());
		this.host.emit();
	}

	/**
	 * Hand off unless `run` has already settled. A reaction on an already settled promise is
	 * queued at once, ahead of the pending-check below whatever the promise's chain depth, so
	 * the outcome never depends on how `start()` chains its own handlers.
	 */
	private handoffIfRunning(): void {
		let settled = false;
		const markSettled = () => {
			settled = true;
		};
		this.running?.then(markSettled, markSettled);
		void Promise.resolve().then(() => {
			if (!settled) this.handoff();
		});
	}

	private publish(update: TaskUpdate<T>): void {
		if (this.record.settled || this.host.closed) return;
		this.record.update((task) => {
			task.result = resultText(update.result);
			if (update.display !== undefined) task.display = boundTaskText(update.display);
		});
		if (update.usage !== undefined) this.usage = structuredClone(update.usage);
		if (!this.detachRequested && !this.handedOff) {
			try {
				this.onUpdate?.(update.result);
			} catch {
				/* UI observers cannot stop execution. */
			}
		}
		this.host.emit();
	}

	private attachOutput(path: string, cleanup?: () => void | Promise<void>): void {
		if (this.record.settled) {
			if (cleanup) throw new Error("Task execution has settled");
			return;
		}
		if (this.record.cleanup) throw new Error("Managed output is already registered");
		// Never truncate a real filesystem path into a different path.
		if (Buffer.byteLength(path) > TASK_PATH_BYTES) throw new Error("Task output path is too large");
		this.record.cleanup = cleanup;
		this.record.update((task) => {
			task.outputPath = path;
		});
		this.host.emit();
	}

	private finish(completion: TaskCompletion<T> | undefined, error?: unknown): void {
		const record = this.record;
		if (record.settled) return;
		record.settled = true;
		this.modeListeners.clear();
		this.releaseParent();
		const status: TaskTerminalStatus = completion
			? (completion.status ?? (this.aborted ? "cancelled" : "completed"))
			: this.aborted
				? "cancelled"
				: "failed";
		record.update((task) => {
			task.endedAt = Date.now();
			task.status = status;
			if (completion) {
				task.result = resultText(completion.result);
				if (completion.display !== undefined) task.display = boundTaskText(completion.display);
				if (completion.error !== undefined) task.error = boundText(completion.error, TASK_ERROR_BYTES);
				if (completion.facts) task.facts = mergeFacts(task.facts, completion.facts);
			} else {
				task.error = errorText(error);
				task.result = prependText(task.error, task.result);
			}
		});
		let warning: string | undefined;
		try {
			this.host.settle(record.snapshot(), completion?.usage ?? completion?.result.usage ?? this.usage);
		} catch (accountingError) {
			const notice = `Usage settlement failed: ${errorText(accountingError)}`;
			warning = notice;
			record.update((task) => {
				task.error = boundText([task.error, notice].filter(Boolean).join("\n"), 2 * TASK_ERROR_BYTES);
				task.result = prependText(notice, task.result);
			});
		}
		this.usage = undefined;
		// Delivery becomes eligible only after settlement is persisted.
		if (this.handedOff) record.queueDelivery();
		else record.acknowledge();
		if (!this.handedOff) {
			if (!completion) this.rejectCaller(error);
			else {
				// The task ledger owns usage; a tool result never carries it a second time.
				const { usage: _usage, ...result } = completion.result;
				if (warning) result.content = [{ type: "text", text: warning }, ...result.content];
				this.resolveCaller({ kind: "result", result, status, error: record.task.error });
			}
		}
		for (const waiter of [...record.waiters]) waiter();
		this.resolveDone();
		this.host.released(this as Execution<unknown>);
	}
}
