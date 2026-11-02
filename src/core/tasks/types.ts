import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";

/** An executor-owned machine source: the task ID prefix, never a dispatch key for the runtime. */
export type TaskKind = string;
/**
 * Where the task actually runs. `background` exactly when its caller was released with a
 * background outcome; a caller that is waiting, or was asked to leave but is still held while
 * the executor prepares, is `foreground`.
 */
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
	/**
	 * The executor's human-only view. In /tasks it replaces the result as what a person reads;
	 * model-facing reads always use `result`. A terminal snapshot has one only if the completion
	 * supplied it: the last progress display does not survive settlement.
	 */
	display?: TaskText;
	error?: string;
}

export interface TaskUpdate<T> {
	/** Model-readable progress; also forwarded to a foreground caller's onUpdate. */
	result: AgentToolResult<T>;
	/** The live human-only view while running; replaces the result in /tasks and ends at settlement. */
	display?: string;
	/** Cumulative usage so far, settled once if the execution ends without a final usage. */
	usage?: Usage;
}

export interface TaskCompletion<T> {
	result: AgentToolResult<T>;
	/** Defaults to completed, or cancelled when the task was already cancelled. */
	status?: TaskTerminalStatus;
	/**
	 * The terminal human-only view. In /tasks it replaces the result as what a person reads; model-facing
	 * reads and completion context always use `result`. Without it, the terminal snapshot has no display.
	 */
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
	/** Actual placement: `background` only once the caller was released. */
	readonly mode: TaskMode;
	/** Called once the caller is released and the mode becomes `background`. */
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
	 * At most `limit` executions sharing `key` run at once; lanes belong to one `kind`, so another
	 * executor may reuse the key. Later ones wait as queued tasks whose `run` starts when a slot
	 * frees; a queued task can be handed off or cancelled.
	 */
	concurrency?: { key: string; limit: number };
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<T>) => void;
	run(control: TaskControl<T>): Promise<TaskCompletion<T>>;
}

/**
 * How a tool call ends. A `background` outcome says why the caller was released: `submitted`
 * when it asked for background, `detached` when it was moved while the work ran.
 */
export type TaskToolOutcome<T> =
	| { kind: "result"; result: AgentToolResult<T>; status: TaskTerminalStatus; error?: string }
	| { kind: "background"; task: TaskSnapshot; reason: "submitted" | "detached" };

/** Which slice of a task's output to read. Defaults to 8 KiB. */
export interface TaskReadOptions {
	/**
	 * `head` reads the start of the output, `tail` its end. Without it a `report` is read from its
	 * start and a `log` from its end.
	 */
	mode?: "head" | "tail";
	/** Maximum bytes to return, bounded by the runtime. */
	bytes?: number;
	/**
	 * First unread byte. `head` reads forward from this offset; `tail` returns the newest window
	 * at or after it. Without it the output kind selects the default end.
	 */
	sinceBytes?: number;
}

export interface TaskRead {
	task: TaskSnapshot;
	text: string;
	/** Bounded log-read/expiry diagnostic, independent of text slicing and byte offsets. */
	readError?: string;
	totalBytes: number;
	truncated: boolean;
	fromByte?: number;
	/** Raw source-byte end supplied by the runtime; older/custom hosts may omit it. */
	endByte?: number;
}

/** Optional host integration for products built on the execution runtime. */
export interface TasksSessionContext {
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
	read(id: string, options?: TaskReadOptions): Promise<TaskRead>;
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
	/** Branch-impact queries for a durable host; standalone runtimes omit it. */
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
	/**
	 * Whether the host can supervise new background work, such as its management tool being
	 * active. Gates admission and detaching only; work already admitted is unaffected.
	 */
	canManageBackground?: () => boolean;
	/** The runtime closed: a host holding retention pins for it must release them so output cleanup runs. */
	onClosed?: () => void;
}

/**
 * The model-facing management tool, owned by the bundled `builtin:tasks` extension. Background
 * work is admitted only while it is active, so the model can always read and stop what
 * it starts. Model-facing copy names it through this constant.
 */
export const TASKS_TOOL_NAME = "tasks";

export const TASK_MANAGEMENT_REJECTION = `Background execution needs the ${TASKS_TOOL_NAME} tool to read and stop the work, and it is not active. Activate the ${TASKS_TOOL_NAME} tool or run in the foreground. No work was started.`;

export const TASK_BACKGROUND_REJECTION =
	"Background execution is not available in this host. Run with background: false or omit background. No work was started.";

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
