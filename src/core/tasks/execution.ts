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

/** queued: waiting for a lane slot; preflight: `run` started, `accept()` not yet called; settled: terminal. */
type Phase = "queued" | "preflight" | "accepted" | "settled";

/**
 * Where the launching tool call stands: still waiting for the result (`caller`), asked to be
 * released but held until the executor accepts (`detaching`), or released with a background
 * outcome (`background`). Only `background` is reported as the task's mode.
 */
type Placement = "caller" | "detaching" | "background";

/**
 * One live task: its caller, controller, parent link and executor callbacks.
 *
 * A caller may be handed off to the background whenever no executor preflight is in
 * progress: before `run` starts (queued) or after the executor calls `accept()`. A release
 * requested during preflight waits for `accept()`; if the run settles first, the caller is
 * answered inline and the task never becomes background.
 */
export class Execution<T> {
	readonly record: TaskRecord;
	readonly kind: string;
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
	private onUpdate?: (result: AgentToolResult<T>) => void;
	private releaseParentSignal: () => void = () => {};
	private usage?: Usage;
	private phase: Phase = "queued";
	private placement: Placement;
	private readonly reason: "submitted" | "detached";
	/** The executor's `run` promise once started. */
	private running?: Promise<TaskCompletion<T>>;

	constructor(host: ExecutionHost, record: TaskRecord, execution: TaskExecution<T>) {
		this.host = host;
		this.record = record;
		this.run = execution.run;
		this.kind = execution.kind;
		this.concurrency = execution.concurrency;
		this.placement = execution.background ? "detaching" : "caller";
		this.reason = execution.background ? "submitted" : "detached";
		this.onUpdate = execution.onUpdate;
		this.caller = new Promise<TaskToolOutcome<T>>((resolve, reject) => {
			this.resolveCaller = resolve;
			this.rejectCaller = reject;
		});
		this.done = record.settlement;
		const parent = execution.signal;
		if (parent) {
			// A caller that is leaving survives the parent's abort unless the executor is mid-preflight.
			const abort = () => {
				if (this.placement === "caller" || this.phase === "preflight") this.cancel();
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

	/** Waiting for a concurrency slot: registered, but `run` has not started. */
	get queued(): boolean {
		return this.phase === "queued";
	}

	/** Holds a background slot: handed off, or asked to be and waiting for the executor to accept. */
	get holdsBackgroundSlot(): boolean {
		return this.phase !== "settled" && this.placement !== "caller";
	}

	get detachable(): boolean {
		return this.phase !== "settled" && this.placement === "caller" && !this.aborted;
	}

	/** Stop forwarding to the launching tool call: parent cancellation and progress no longer reach it. */
	releaseParent(): void {
		this.releaseParentSignal();
		this.releaseParentSignal = () => {};
		this.onUpdate = undefined;
	}

	start(): void {
		if (this.phase !== "queued") return;
		if (this.host.closed) {
			this.cancel();
			return;
		}
		this.phase = "preflight";
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

	/** Queued background work returns at once; started work is released at its own `accept()`. */
	handOffIfQueued(): void {
		if (this.phase === "queued" && this.handoff()) this.announceBackground();
	}

	/**
	 * Ask to move the caller to the background. The placement changes now; the returned
	 * notification is for the caller of a batch to run after every placement has changed, so no
	 * listener ever observes a half-moved set.
	 */
	detach(): () => void {
		this.placement = "detaching";
		const released = this.handoff();
		return () => {
			if (released) this.announceBackground();
		};
	}

	cancel(): boolean {
		if (this.phase === "settled" || this.aborted) return false;
		this.record.update((task) => {
			task.status = "stopping";
		});
		this.controller.abort();
		if (this.phase === "queued") this.finish(undefined, new Error("Task cancelled before it started."));
		this.host.emit();
		return true;
	}

	private onModeChange(listener: (mode: TaskMode) => void): () => void {
		if (this.phase === "settled" || this.host.closed) return () => {};
		this.modeListeners.add(listener);
		return () => {
			this.modeListeners.delete(listener);
		};
	}

	private accept(): void {
		if (this.phase !== "preflight" || this.host.closed || this.aborted) return;
		this.phase = "accepted";
		if (this.placement === "detaching") this.releaseParent();
		// An already available final result wins over a handoff, so decide only once the
		// executor's own synchronous code has yielded.
		queueMicrotask(() => this.handoffIfRunning());
		this.host.emit();
	}

	/**
	 * Hand off unless `run` has already settled. This observes the `run` promise's own settlement,
	 * not the phase `finish()` sets: a reaction on an already settled promise is queued at once,
	 * ahead of the pending-check below whatever the promise's chain depth, so the outcome never
	 * depends on how many hops `start()` chains before `finish()`.
	 */
	private handoffIfRunning(): void {
		let settled = false;
		const markSettled = () => {
			settled = true;
		};
		this.running?.then(markSettled, markSettled);
		void Promise.resolve().then(() => {
			if (!settled && this.handoff()) this.announceBackground();
		});
	}

	/**
	 * Release the caller with a background outcome if it asked to leave and the executor's
	 * preflight is over. The task is background exactly from here on.
	 */
	private handoff(): boolean {
		if (
			this.placement !== "detaching" ||
			(this.phase !== "queued" && this.phase !== "accepted") ||
			this.host.closed ||
			!this.record.visible ||
			this.aborted
		)
			return false;
		this.placement = "background";
		this.record.update((task) => {
			task.mode = "background";
		});
		this.releaseParent();
		this.resolveCaller({ kind: "background", task: this.record.snapshot(), reason: this.reason });
		return true;
	}

	private announceBackground(): void {
		for (const listener of [...this.modeListeners]) {
			try {
				listener("background");
			} catch {
				/* Executors own their diagnostics. */
			}
		}
		this.host.emit();
	}

	private publish(update: TaskUpdate<T>): void {
		if (this.phase === "settled" || this.host.closed) return;
		this.record.update((task) => {
			task.result = resultText(update.result);
			if (update.display !== undefined) task.display = boundTaskText(update.display);
		});
		if (update.usage !== undefined) this.usage = structuredClone(update.usage);
		if (this.placement === "caller") {
			try {
				this.onUpdate?.(update.result);
			} catch {
				/* UI observers cannot stop execution. */
			}
		}
		this.host.emit();
	}

	private attachOutput(path: string, cleanup?: () => void | Promise<void>): void {
		if (this.phase === "settled") {
			if (cleanup) throw new Error("Task execution has settled");
			return;
		}
		// Never truncate a real filesystem path into a different path.
		if (Buffer.byteLength(path) > TASK_PATH_BYTES) throw new Error("Task output path is too large");
		this.record.attachOutput(path, cleanup);
		this.host.emit();
	}

	private finish(completion: TaskCompletion<T> | undefined, error?: unknown): void {
		const record = this.record;
		if (this.phase === "settled") return;
		this.phase = "settled";
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
			// Progress display is the executor's live view; a terminal snapshot shows only what the completion gives.
			task.display = completion?.display === undefined ? undefined : boundTaskText(completion.display);
			if (completion) {
				task.result = resultText(completion.result);
				if (completion.error !== undefined) task.error = boundText(completion.error, TASK_ERROR_BYTES);
				if (completion.facts) task.facts = mergeFacts(task.facts, completion.facts);
			} else {
				task.error = errorText(error);
				task.result = prependText(task.error, task.result);
			}
		});
		// The caller sees the executor's own diagnostic; a settlement warning is already in its content.
		const diagnostic = record.task.error;
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
		if (this.placement !== "background") {
			if (!completion) this.rejectCaller(error);
			else {
				// The task ledger owns usage; a tool result never carries it a second time.
				const { usage: _usage, ...result } = completion.result;
				if (warning) result.content = [{ type: "text", text: warning }, ...result.content];
				this.resolveCaller({ kind: "result", result, status, error: diagnostic });
			}
		}
		record.settle();
		this.host.released(this as Execution<unknown>);
	}
}
