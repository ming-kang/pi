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
	/** Ends only management-tool waits when new steering arrives. */
	readonly waitInterruptSignal?: AbortSignal;
	/** Hold a settled result until the wait's tool result has been persisted. */
	prepareWait(toolCallId: string, taskId: string): void;
	/** Running tasks that navigating to `targetId` would cancel on this session branch. */
	stoppedByTreeNavigation(targetId: string): TaskSnapshot[];
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
	/** Observation only: terminal delivery is acknowledged by the host via markDelivered after result persistence. */
	wait(id: string, timeoutMs?: number, signal?: AbortSignal, interruptSignal?: AbortSignal): Promise<TaskSnapshot>;
	/**
	 * Observe the first task running at call time to settle. Returns undefined when there is
	 * no such task, the window ends, or interruptSignal fires. Tasks started later are excluded.
	 */
	waitAny(timeoutMs?: number, signal?: AbortSignal, interruptSignal?: AbortSignal): Promise<TaskSnapshot | undefined>;
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
	/** Hold automatic delivery while preparing a result for the host to persist. */
	holdDelivery(id: string): () => void;
}

export interface TaskRuntimeOptions {
	enabled?: boolean;
	backgroundAllowed?: boolean;
	/** Durable host integration; standalone runtimes leave waits observational. */
	session?: TasksSessionContext;
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
