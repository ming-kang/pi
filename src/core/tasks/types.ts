import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";

/** An executor-owned machine source: the task ID prefix, never a dispatch key for the runtime. */
export type TaskKind = string;
export type TaskMode = "foreground" | "background";
export const TASK_TERMINAL_STATUSES = ["completed", "partial", "failed", "cancelled", "timeout"] as const;
export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];
export type TaskStatus = "queued" | "running" | "stopping" | TaskTerminalStatus;
export const TASK_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * How a task's output is shaped, declared by its executor:
 * a `log` streams and carries its outcome at the end; a `report` is one finished document.
 */
export type TaskOutputKind = "log" | "report";

/** A bounded snapshot; truncation is recorded at the source, never inferred from text. */
export interface TaskText {
	text: string;
	truncated: boolean;
}

/** What the task was asked to do, such as a shell command or a delegated briefing. */
export interface TaskInput extends TaskText {
	/** Human label for the input, such as "Command" or "Prompt". */
	label: string;
	/** Optional syntax-highlighting language. */
	language?: string;
}

/** One labelled Details row, such as ["Directory", "/repo"] or ["Exit", "1"]. */
export type TaskFact = readonly [label: string, value: string];

/** A read-only view of one task; the runtime returns frozen snapshots. */
export interface TaskSnapshot {
	id: string;
	kind: TaskKind;
	/** Human source name, such as "Bash" or "Agent". */
	label: string;
	title: string;
	output: TaskOutputKind;
	input?: TaskInput;
	facts?: TaskFact[];
	toolCallId: string;
	anchorId: string | null;
	mode: TaskMode;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	outputPath?: string;
	/** Bounded model-readable result text. */
	result?: TaskText;
	/** Additional human-only Output text; model-facing reads use the result instead. */
	display?: TaskText;
	error?: string;
}

export interface TaskUpdate<T> {
	/** Model-readable progress; also forwarded to a foreground caller's onUpdate. */
	result: AgentToolResult<T>;
	/** Additional human-only Output text. */
	display?: string;
	/** Cumulative usage so far, settled once if the execution ends without a final usage. */
	usage?: Usage;
}

export interface TaskCompletion<T> {
	result: AgentToolResult<T>;
	/** Defaults to completed, or cancelled when the task was already cancelled. */
	status?: TaskTerminalStatus;
	/** Additional human-only Output text, excluded from tasks read and completion context. */
	display?: string;
	/** Terminal diagnostic, stored independently of log slices and bounded to 4096 bytes. */
	error?: string;
	/** Terminal Details rows; a label replaces the same label given at launch. */
	facts?: TaskFact[];
	/** Authoritative cumulative usage; overrides the result's usage and the latest published usage. */
	usage?: Usage;
}

export interface TaskControl<T> {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly mode: TaskMode;
	onModeChange(listener: (mode: TaskMode) => void): () => void;
	/** The executor's own preflight passed; from now on the caller may be handed off to the background. */
	accept(): void;
	publish(update: TaskUpdate<T>): void;
	/** Register once; cleanup must own only this exclusively-created file and close its writer first. */
	attachOutput(path: string, cleanup?: () => void | Promise<void>): void;
	/** Cancel this execution, for example when an executor policy limit is exceeded. */
	cancel(): void;
}

export interface TaskExecution<T> {
	kind: TaskKind;
	/** Human source name; defaults to `kind`. */
	label?: string;
	title: string;
	/** Defaults to `log`. */
	output?: TaskOutputKind;
	input?: TaskInput;
	facts?: TaskFact[];
	toolCallId: string;
	background?: boolean;
	/**
	 * At most `limit` executions sharing `key` run at once. Later ones wait as queued tasks
	 * whose `run` starts when a slot frees; a queued task can be handed off or cancelled.
	 */
	concurrency?: { key: string; limit: number };
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<T>) => void;
	run(control: TaskControl<T>): Promise<TaskCompletion<T>>;
}

export type TaskToolOutcome<T> =
	| { kind: "result"; result: AgentToolResult<T>; status: TaskTerminalStatus; error?: string }
	| { kind: "background"; task: TaskSnapshot };

export interface TaskRead {
	task: TaskSnapshot;
	text: string;
	/** Bounded log-read/expiry diagnostic, independent of text slicing and byte offsets. */
	readError?: string;
	totalBytes: number;
	truncated: boolean;
	fromByte?: number;
}

/** Optional host integration for products built on the execution runtime. */
export interface TasksSessionContext {
	/** Running tasks that navigating to `targetId` would cancel on this session branch. */
	stoppedByTreeNavigation(targetId: string): TaskSnapshot[];
}

/** How a wait ended. `closed` means the host shut down, so execution state is unconfirmed. */
export type TaskWaitOutcome = "settled" | "interrupted" | "timed_out" | "closed";

interface TaskObservationOptions {
	/** Defaults to 20 seconds and is bounded by the runtime. A timeout never cancels execution. */
	timeoutMs?: number;
	/** Rejects the wait with the signal's reason; execution continues. */
	signal?: AbortSignal;
	/**
	 * The tool call whose result carries this observation to the model. With a session host, a
	 * settled background task stays out of automatic notifications until that result is persisted.
	 * Without it, or in a standalone runtime, the wait is purely observational.
	 */
	toolCallId?: string;
}

export interface TaskWaitOptions extends TaskObservationOptions {
	/** Read output while delivery is still held; skipped when steering interrupted the wait. */
	read?: { bytes?: number; sinceBytes?: number };
}

export interface TaskWaitResult {
	outcome: TaskWaitOutcome;
	waitedMs: number;
	/** The task when the wait ended, before `read` was taken. */
	task: TaskSnapshot;
	read?: TaskRead;
}

export interface TaskWaitAnyOptions extends TaskObservationOptions {
	/** Read the settled task's output while delivery is still held. */
	read?: { bytes?: number };
}

export interface TaskWaitAnyResult {
	/** `no_tasks`: no background task was running at call time, so nothing was observed. */
	outcome: TaskWaitOutcome | "no_tasks";
	waitedMs: number;
	/** The first cohort member to settle; present only for `settled`. */
	task?: TaskSnapshot;
	read?: TaskRead;
	/** Cohort members still running when the wait ended. */
	running: TaskSnapshot[];
}

/**
 * Host hooks that make waits part of a durable session. TaskSession supplies them; products
 * embedding a bare TaskRuntime omit them and keep waits observational.
 */
export interface TaskWaitHost {
	/** Current steering signal. Aborting it ends management waits only, never execution. */
	readonly interruptSignal: AbortSignal;
	/**
	 * A wait observed a settled background task and its `toolCallId` is known. Called while the
	 * runtime still holds delivery; the host takes over until that tool result persists.
	 */
	bind(toolCallId: string, taskId: string): void;
}

/**
 * What TaskDelivery consumes from the runtime. The runtime keeps only the per-record facts that
 * retention and admission need (a settled handoff is undelivered, claimed or delivered, and a
 * record under a hold is never a candidate); pausing, failure tracking, the in-flight delivery
 * and wait receipts belong to TaskDelivery.
 */
export interface TaskDeliveryLedger {
	readonly enabled: boolean;
	list(): TaskSnapshot[];
	/** Settled handoffs eligible for automatic delivery: visible, unclaimed, unobserved and unheld. */
	pendingNotifications(): TaskSnapshot[];
	/** Take a pending notification; false when it is no longer a candidate. */
	claimNotification(id: string): boolean;
	/** Return a claimed notification to pending after a failed delivery. */
	releaseNotification(id: string): void;
	/** Acknowledge a persisted delivery or wait result. */
	markDelivered(id: string): void;
	/** Keep a record out of automatic delivery, and its output retained, until released. */
	holdDelivery(id: string): () => void;
}

/** Session-bound public capability. Captured instances close on runtime replacement. */
export interface TasksContext {
	readonly enabled: boolean;
	readonly closed?: boolean;
	/** Present when the runtime is attached to Pi's durable session lifecycle. */
	readonly session?: TasksSessionContext;
	execute<T>(execution: TaskExecution<T>): Promise<TaskToolOutcome<T>>;
	list(): TaskSnapshot[];
	get(id: string): TaskSnapshot;
	read(id: string, options?: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number }): Promise<TaskRead>;
	/**
	 * Observe one task. With `toolCallId` in a session host, the whole observation (wait, read,
	 * receipt) is atomic with respect to automatic delivery; a standalone runtime never
	 * acknowledges delivery. Rejects with `TaskLookupError` for an unknown or ambiguous id.
	 */
	wait(id: string, options?: TaskWaitOptions): Promise<TaskWaitResult>;
	/**
	 * Observe the first task running at call time to settle. Tasks started later are excluded,
	 * and `no_tasks` is returned for an empty cohort. Delivery holds cover the whole cohort until
	 * the observation completes; members other than the winner then resume ordinary notification.
	 */
	waitAny(options?: TaskWaitAnyOptions): Promise<TaskWaitAnyResult>;
	kill(id: string): boolean;
	/**
	 * Move running foreground executions to the background while background slots remain;
	 * returns how many moved. Throws when eligible work exists but every slot is taken.
	 */
	detachForeground(): number;
	/** Whether this execution can move now, including host policy and available background slots. */
	canDetach(id: string): boolean;
	/** Returns false when the task cannot move; throws when every background slot is taken. */
	detach(id: string): boolean;
	subscribe(listener: () => void): () => void;
	/** Keep retained output available without delaying completion delivery. */
	retain(id: string): () => void;
}

export interface TaskRuntimeOptions {
	enabled?: boolean;
	backgroundAllowed?: boolean;
	/** Branch-impact queries for a durable host; standalone runtimes omit it. */
	session?: TasksSessionContext;
	/** Wait receipts and steering interruption for a durable host; standalone runtimes leave waits observational. */
	waits?: TaskWaitHost;
	anchor?: () => string | null;
	/** Admission limit for unsettled background tasks; foreground work is bounded by its caller. */
	maxBackground?: number;
	/** Per-history limit: foreground and background tasks each get this allowance. */
	maxHistory?: number;
	/** Best-effort cleanup errors, bounded to 4096 bytes; no retries or execution failure. */
	onCleanupError?: (message: string) => void;
	/** Synchronous persistence before terminal observers or notifications. */
	onSettled?: (task: TaskSnapshot, usage: Usage | undefined) => void;
}

export const TASK_BACKGROUND_REJECTION =
	"Background execution is not permitted in this host. Run with background: false or omit background. No work was started.";

export function isTaskTerminal(status: TaskStatus): status is TaskTerminalStatus {
	return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A failed id lookup, typed so hosts can enrich the message without matching
 * on message text. `matches` snapshots exactly the records the id or prefix
 * resolved against — including records outside the current branch, which
 * list() hides but prefix matching still collides with.
 */
export class TaskLookupError extends Error {
	readonly kind: "unknown" | "ambiguous";
	readonly matches: TaskSnapshot[];
	constructor(kind: "unknown" | "ambiguous", matches: TaskSnapshot[]) {
		super(kind === "ambiguous" ? "Ambiguous task ID" : "Unknown task ID");
		this.name = "TaskLookupError";
		this.kind = kind;
		this.matches = matches;
	}
}
