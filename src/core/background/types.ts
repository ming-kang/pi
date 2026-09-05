import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";

export type BackgroundKind = "bash" | "subagent";
export type BackgroundMode = "foreground" | "background";
export type BackgroundTerminalStatus = "completed" | "partial" | "failed" | "cancelled" | "timeout";
export type BackgroundStatus = "queued" | "running" | "stopping" | BackgroundTerminalStatus;

/** A serializable, domain-owned projection. No extension-private renderer imports. */
export interface BackgroundWorker {
	id: string;
	label: string;
	status: string;
	prompt: string;
	activity: string;
	outcome: string;
	model?: string;
	usage?: string;
}

export interface BackgroundProjection {
	text?: string;
	workers?: BackgroundWorker[];
}

export interface BackgroundTask {
	id: string;
	kind: BackgroundKind;
	title: string;
	toolCallId: string;
	anchorId: string | null;
	mode: BackgroundMode;
	status: BackgroundStatus;
	startedAt: number;
	endedAt?: number;
	command?: string;
	cwd?: string;
	outputPath?: string;
	projection?: BackgroundProjection;
	result?: AgentToolResult<unknown>;
	error?: string;
}

export interface BackgroundCompletion<T> {
	result: AgentToolResult<T>;
	status?: BackgroundTerminalStatus;
	/** Terminal diagnostic, stored independently of log slices and bounded to 4096 bytes. */
	error?: string;
	/** Authoritative cumulative usage; overrides result.usage and any published snapshot. */
	usage?: Usage;
}

export interface BackgroundControl<T> {
	readonly id: string;
	readonly signal: AbortSignal;
	readonly mode: BackgroundMode;
	/** Accept only after whole-invocation preflight; required before returning a handoff. */
	accept(): void;
	/**
	 * result.usage is a cumulative snapshot, never a delta. The most recent explicitly
	 * published usage is settled once on rejection (never inferred from details).
	 * Final completion.usage, then completion.result.usage, override that snapshot.
	 */
	publish(result: AgentToolResult<T>, projection?: BackgroundProjection): void;
	/** Register once; cleanup must own only this exclusively-created file and close its writer first. */
	setOutputPath(path: string, cleanup?: () => void | Promise<void>): void;
}

export interface BackgroundExecution<T> {
	kind: BackgroundKind;
	title: string;
	toolCallId: string;
	command?: string;
	cwd?: string;
	background?: boolean;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<T>) => void;
	run(control: BackgroundControl<T>): Promise<BackgroundCompletion<T>>;
}

export type BackgroundToolOutcome<T> =
	| { kind: "result"; result: AgentToolResult<T>; status?: BackgroundTerminalStatus; error?: string }
	| { kind: "background"; task: BackgroundTask };

export interface BackgroundRead {
	task: BackgroundTask;
	text: string;
	/** Bounded log-read/expiry diagnostic, independent of text slicing and byte offsets. */
	readError?: string;
	totalBytes: number;
	truncated: boolean;
	fromByte?: number;
}

/** Session-bound public capability. Captured instances close on runtime replacement. */
export interface BackgroundContext {
	readonly enabled: boolean;
	readonly closed?: boolean;
	execute<T>(execution: BackgroundExecution<T>): Promise<BackgroundToolOutcome<T>>;
	list(): BackgroundTask[];
	get(id: string): BackgroundTask;
	read(id: string, options?: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number }): Promise<BackgroundRead>;
	/** Observation only: terminal delivery is acknowledged by the host via markDelivered after result persistence. */
	wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<BackgroundTask>;
	kill(id: string): boolean;
	subscribe(listener: () => void): () => void;
	pin(id: string): () => void;
}

export interface BackgroundServiceOptions {
	enabled?: boolean;
	role?: "main" | "subagent";
	anchor?: () => string | null;
	maxActive?: number;
	maxHistory?: number;
	/** Best-effort cleanup errors, bounded to 4096 bytes; no retries or execution failure. */
	onCleanupError?: (message: string) => void;
	/** Synchronous persistence before terminal observers or notifications. */
	onSettled?: (task: BackgroundTask, usage: Usage | undefined) => void;
}

export const SUBAGENT_BACKGROUND_REJECTION =
	"Background execution is not available inside subagents. Run this command with background: false (or omit background). Only the parent agent or the user can background the entire subagent invocation. No command was started.";

export function isBackgroundTerminal(status: BackgroundStatus): boolean {
	return status !== "queued" && status !== "running" && status !== "stopping";
}

/** Preserve the foreground throwing contract without guessing status from output text. */
export class BackgroundExecutionError extends Error {
	readonly status: BackgroundTerminalStatus;
	constructor(message: string, status: BackgroundTerminalStatus) {
		super(message);
		this.name = "BackgroundExecutionError";
		this.status = status;
	}
}
