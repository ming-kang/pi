import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";

/** An executor-owned source label, never a dispatch key for the runtime. */
export type TaskKind = string;
export type TaskMode = "foreground" | "background";
export type TaskTerminalStatus = "completed" | "partial" | "failed" | "cancelled" | "timeout";
export type TaskStatus = "queued" | "running" | "stopping" | TaskTerminalStatus;

/** A bounded snapshot; truncation is recorded at the source, never inferred from text. */
export interface TaskText {
	text: string;
	truncated: boolean;
}

export interface TaskItemReport {
	id: string;
	label: string;
	category: string;
	description: string;
	status: string;
	report: TaskText;
	error?: string;
}

/** A serializable, domain-owned projection. No extension-private renderer imports. */
export interface TaskItem extends TaskItemReport {
	input: string;
	activity: string;
	context?: string;
	usage?: string;
}

export interface TaskProjection {
	nextStep?: string;
	text?: string;
	shell?: { name: string; output: TaskText };
	items?: TaskItem[];
}

interface TaskCompletionBase {
	kind: string;
	version: 1;
	taskId: string;
	title: string;
	status: TaskTerminalStatus;
	startedAt: number;
	endedAt: number;
	error?: string;
	nextStep?: string;
}

/** Self-contained completion-message details. No live handles, tool-private details or accounting. */
export type TaskCompletionSnapshot = TaskCompletionBase &
	(
		| {
				format: "log";
				shell?: string;
				command?: TaskText;
				cwd?: string;
				outputPath?: string;
				/** Process exit code: a number, or null when signal-reaped. */
				exitCode?: number | null;
				output: TaskText;
		  }
		| {
				format: "report";
				items: TaskItemReport[];
				/** Plain fallback when an executor has no worker projection. */
				output?: TaskText;
		  }
	);

export interface TaskSnapshot {
	id: string;
	kind: TaskKind;
	format?: "log" | "report";
	title: string;
	toolCallId: string;
	anchorId: string | null;
	mode: TaskMode;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	command?: string;
	commandTruncated?: boolean;
	cwd?: string;
	/** Process exit code (bash): a number, or null when signal-reaped. Absent while running or unreported. */
	exitCode?: number | null;
	outputPath?: string;
	projection?: TaskProjection;
	result?: AgentToolResult<unknown>;
	resultTruncated?: boolean;
	error?: string;
}

export interface TaskCompletion<T> {
	result: AgentToolResult<T>;
	status?: TaskTerminalStatus;
	/** Terminal diagnostic, stored independently of log slices and bounded to 4096 bytes. */
	error?: string;
	/** Process exit code (bash): a number, or null when signal-reaped. */
	exitCode?: number | null;
	/** Authoritative cumulative usage; overrides result.usage and any published snapshot. */
	usage?: Usage;
}

export interface TaskControl<T> {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly mode: TaskMode;
	onModeChange(listener: (mode: TaskMode) => void): () => void;
	requestCancel(): boolean;
	/** Accept only after whole-invocation preflight; required before returning a handoff. */
	accept(): void;
	/**
	 * result.usage is a cumulative snapshot, never a delta. The most recent explicitly
	 * published usage is settled once on rejection (never inferred from details).
	 * Final completion.usage, then completion.result.usage, override that snapshot.
	 */
	publish(result: AgentToolResult<T>, projection?: TaskProjection): void;
	/** Register once; cleanup must own only this exclusively-created file and close its writer first. */
	setOutputPath(path: string, cleanup?: () => void | Promise<void>): void;
}

export interface TaskExecution<T> {
	kind: TaskKind;
	format?: "log" | "report";
	title: string;
	toolCallId: string;
	command?: string;
	cwd?: string;
	background?: boolean;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<T>) => void;
	run(control: TaskControl<T>): Promise<TaskCompletion<T>>;
}

export type TaskToolOutcome<T> =
	| { kind: "result"; result: AgentToolResult<T>; status?: TaskTerminalStatus; error?: string }
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

/** Session-bound public capability. Captured instances close on runtime replacement. */
export interface TasksContext {
	readonly enabled: boolean;
	readonly closed?: boolean;
	execute<T>(execution: TaskExecution<T>): Promise<TaskToolOutcome<T>>;
	list(): TaskSnapshot[];
	get(id: string): TaskSnapshot;
	read(id: string, options?: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number }): Promise<TaskRead>;
	/** Observation only: terminal delivery is acknowledged by the host via markDelivered after result persistence. */
	wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<TaskSnapshot>;
	kill(id: string): boolean;
	/** Move every running foreground execution to the background; returns how many moved. */
	detachForeground(): number;
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
	anchor?: () => string | null;
	maxActive?: number;
	/** Per-history limit: foreground shells and background tasks/all subagents each get this allowance. */
	maxHistory?: number;
	/** Best-effort cleanup errors, bounded to 4096 bytes; no retries or execution failure. */
	onCleanupError?: (message: string) => void;
	/** Synchronous persistence before terminal observers or notifications. */
	onSettled?: (task: TaskSnapshot, usage: Usage | undefined) => void;
}

export const TASK_BACKGROUND_REJECTION =
	"Background execution is not permitted in this host. Run with background: false or omit background. No work was started.";

export function isTaskTerminal(status: TaskStatus): boolean {
	return status !== "queued" && status !== "running" && status !== "stopping";
}

/** Foreground shell logs have their own history; subagent groups remain inspectable in either mode. */
export function isInlineLogTask(task: Pick<TaskSnapshot, "format" | "mode">): boolean {
	return task.format === "log" && task.mode === "foreground";
}

/** Preserve the foreground throwing contract without guessing status from output text. */
export class TaskExecutionError extends Error {
	readonly status: TaskTerminalStatus;
	constructor(message: string, status: TaskTerminalStatus) {
		super(message);
		this.name = "TaskExecutionError";
		this.status = status;
	}
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
		super(kind === "ambiguous" ? "Ambiguous background task ID" : "Unknown background task ID");
		this.name = "TaskLookupError";
		this.kind = kind;
		this.matches = matches;
	}
}
