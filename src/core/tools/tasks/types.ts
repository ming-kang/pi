/**
 * The `tasks` tool's structured `details` payloads.
 *
 * Every shape here is JSON-serialized verbatim into the session file and read back
 * by the renderers on `/reload`, `/tree`, and session resume. Adding an optional
 * field is free; renaming or repurposing an existing one degrades historical
 * transcripts.
 *
 * `exitCode` is three-state: `null` for signal-reaped tasks.
 */

import type { TaskKind, TaskStatus } from "../../tasks/types.ts";

export interface TasksReadDetails {
	kind?: TaskKind;
	status?: TaskStatus;
	action: "read";
	taskId: string;
	mode: "head" | "tail";
	sliceBytes: number;
	totalBytes: number;
	outputPath: string;
}

export interface TasksWaitDetails {
	kind?: TaskKind;
	action: "wait";
	taskId: string;
	/** True when the wait window expired and the task is still running. */
	timedOut: boolean;
	status: TaskStatus;
	exitCode: number | null | undefined;
	waitedMs: number;
	deltaBytes: number;
	totalBytes: number;
	deltaTruncated: boolean;
	outputPath: string;
}

export interface TasksKillDetails {
	requested?: boolean;
	status?: TaskStatus;
	action: "kill";
	taskId: string;
	command: string;
}

export interface TasksListDetails {
	action: "list";
	running: number;
	finished: number;
	shown: number;
	hidden: number;
	/** Foreground executions omitted from the listing; they deliver inline in the transcript. */
	foregroundOmitted?: number;
}

export type TasksDetails = TasksReadDetails | TasksKillDetails | TasksListDetails | TasksWaitDetails;
