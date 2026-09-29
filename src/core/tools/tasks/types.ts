/**
 * background — the structured `details` payloads.
 *
 * PERSISTENCE CONTRACT: every shape here is JSON-serialized verbatim into the
 * session file (agent-session.ts -> session-manager.ts) and read back by this
 * extension's renderers on `/reload`, `/tree`, and session resume — so a
 * renderer always has to cope with details written by an older build. Adding an
 * optional field is free; renaming or repurposing an existing one silently
 * degrades historical transcripts, because components/custom-message.ts catches
 * renderer failures and falls back to an unstyled box with no diagnostic.
 *
 * Keep `exitCode` three-state for the same reason: historical entries hold
 * `null` for signal-reaped tasks. task-view.ts's `exitSuffix` is the one place
 * that has to know.
 */

import type { TaskKind, TaskStatus } from "../../tasks/types.ts";

/** Historical transcripts used killed rather than cancelled. */
export type TasksTaskStatus = TaskStatus | "killed";

export interface TasksCreateDetails {
	action: "create";
	taskId: string;
	outputPath: string;
	command: string;
	description?: string;
}

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
	status: TasksTaskStatus;
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

export type TasksDetails =
	| TasksCreateDetails
	| TasksReadDetails
	| TasksKillDetails
	| TasksListDetails
	| TasksWaitDetails;

export interface TasksNotificationDetails {
	taskId: string;
	command: string;
	description?: string;
	status: TasksTaskStatus;
	/** True for the one-shot "waiting for interactive input" signal; the task keeps running. */
	stalled?: true;
	exitCode: number | null | undefined;
	runtimeMs: number;
	outputPath: string;
	totalBytes: number;
	tailText: string;
	tailTruncated: boolean;
	error?: string;
	tailError?: string;
}
