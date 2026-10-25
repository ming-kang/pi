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

export type TasksWaitOutcome = "settled" | "interrupted" | "timed_out" | "no_tasks";

export interface TasksWaitDetails {
	kind?: TaskKind;
	action: "wait";
	/** Absent only in historical results; new calls always record the reason the wait ended. */
	outcome?: TasksWaitOutcome;
	/** Undefined for waitAny with no selected task, or when no tasks were running. */
	taskId?: string;
	/** Retained for compatibility with historical details; true only for a wait-window expiry. */
	timedOut: boolean;
	status?: TaskStatus;
	exitCode: number | null | undefined;
	waitedMs: number;
	deltaBytes: number;
	totalBytes: number;
	deltaTruncated: boolean;
	outputPath: string;
	/** Initial waitAny cohort members still running when the wait ended. */
	running?: number;
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
