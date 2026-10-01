/** Management only: execution and delivery belong to the session task runtime. */

import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import type { AgentToolResult } from "../../extensions/types.ts";
import { runtimeLabel } from "../../tasks/format.ts";
import { boundText } from "../../tasks/output.ts";
import {
	isTaskTerminal,
	TaskLookupError,
	type TaskRead,
	type TaskSnapshot,
	type TasksContext,
} from "../../tasks/types.ts";
import { truncateHead } from "../truncate.ts";
import { TASKS_LIST_FINISHED_SHOWN, TASKS_WAIT_DELTA_BYTES } from "./constants.ts";
import { clampReadBytes, clampSinceBytes, clampWaitMs, requireTaskId, type TasksInput } from "./schema.ts";
import type { TasksDetails, TasksKillDetails, TasksListDetails, TasksReadDetails, TasksWaitDetails } from "./types.ts";

export function boundedText(text: string): string {
	return truncateHead(sanitizeBinaryOutput(text), { maxBytes: 50 * 1024, maxLines: 2000 }).content;
}
function result<T extends TasksDetails>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text: boundedText(text) }], details };
}
export function describeTaskLine(task: TaskSnapshot, now = Date.now()): string {
	return `${task.id} ${task.kind} ${task.status} (${task.mode}) ${runtimeLabel(task, now)} ${task.title.slice(0, 200)}`;
}

const LOOKUP_LIST_LIMIT = 10;

/**
 * Finished rows sort most-recent first. list() is creation-ordered, so an
 * unsorted slice would surface the oldest completions rather than the recent
 * finishes a caller is most likely looking for.
 */
function recentFinishedFirst(tasks: TaskSnapshot[]): TaskSnapshot[] {
	return tasks.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
}

/**
 * Listings cover backgrounded work only; foreground executions deliver inline
 * in the transcript, so they are counted rather than shown. Every listing
 * (tasks list output and lookup-failure messages) shares this scope.
 */
function listedTasks(background: TasksContext): { tasks: TaskSnapshot[]; foregroundOmitted: number } {
	const all = background.list();
	const tasks = all.filter((task) => task.mode === "background");
	return { tasks, foregroundOmitted: all.length - tasks.length };
}

function foregroundOmissionNote(omitted: number): string {
	return omitted > 0
		? `\n${omitted} foreground ${omitted === 1 ? "execution" : "executions"} omitted — foreground work is delivered inline in the transcript.`
		: "";
}

/**
 * Rewrite the service's bare lookup failure into an actionable one: an
 * unknown id gets the session's current tasks (active first, then recent
 * finishes) so the next call can use a real id without a separate list call,
 * and an ambiguous prefix gets exactly the tasks it matched — including
 * records outside the current branch, which listings hide but the prefix
 * still collides with.
 */
function lookupFailure(background: TasksContext, id: string, error: unknown): Error {
	if (!(error instanceof TaskLookupError)) return error instanceof Error ? error : new Error(String(error));
	if (error.kind === "ambiguous") {
		const lines = error.matches.map((task) => describeTaskLine(task)).join("\n");
		return new Error(`Ambiguous task ID "${id}" matches ${error.matches.length} tasks:\n${lines}`);
	}
	const { tasks, foregroundOmitted } = listedTasks(background);
	const active = tasks.filter((task) => !isTaskTerminal(task.status));
	const finished = recentFinishedFirst(tasks.filter((task) => isTaskTerminal(task.status)));
	const shown = [...active, ...finished].slice(0, LOOKUP_LIST_LIMIT);
	if (shown.length === 0) {
		return new Error(`No task "${id}" in this session. No background tasks in this session.`);
	}
	const lines = shown.map((task) => describeTaskLine(task)).join("\n");
	return new Error(
		`No task "${id}" in this session. IDs from other sessions are not valid here.\nCurrent background tasks:\n${lines}${foregroundOmissionNote(foregroundOmitted)}`,
	);
}

/**
 * Where this slice sits in the output, so the next wait can continue from it.
 * A wait whose new output exceeds its budget returns the newest bytes and says what it skipped.
 */
function rangeText(slice: TaskRead, sinceBytes?: number): string {
	const from = slice.fromByte ?? 0;
	const to = from + Buffer.byteLength(slice.text);
	const floor = sinceBytes === undefined || sinceBytes > slice.totalBytes ? 0 : sinceBytes;
	return [
		`bytes ${from}–${to} of ${slice.totalBytes}`,
		sinceBytes !== undefined && from > floor ? `skipped ${from - floor} bytes after sinceBytes ${floor}` : "",
		`next sinceBytes ${to}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Reserve space for each independent diagnostic before allowing raw output to fill the budget. */
function readText(header: string, slice: TaskRead): string {
	const boundedField = (text: string, maxBytes: number) =>
		truncateHead(boundText(sanitizeBinaryOutput(text), maxBytes), { maxBytes, maxLines: 100 }).content;
	return [
		boundedField(header, 4096),
		slice.task.error ? `Task error: ${boundedField(slice.task.error, 4096)}` : "",
		slice.readError ? `Output read error: ${boundedField(slice.readError, 4096)}` : "",
		boundedField(slice.task.outputPath ?? "", 8192),
		slice.text || "(no output yet)",
	]
		.filter(Boolean)
		.join("\n");
}
export async function runRead(background: TasksContext, input: TasksInput): Promise<AgentToolResult<TasksReadDetails>> {
	const id = requireTaskId(input);
	try {
		const mode = input.mode ?? "tail";
		const slice = await background.read(id, { mode, bytes: clampReadBytes(input.bytes) });
		return result(readText(`[${describeTaskLine(slice.task)} · ${rangeText(slice)}]`, slice), {
			action: "read",
			taskId: slice.task.id,
			mode,
			sliceBytes: Buffer.byteLength(slice.text),
			totalBytes: slice.totalBytes,
			outputPath: slice.task.outputPath ?? "",
			kind: slice.task.kind,
			status: slice.task.status,
		});
	} catch (error) {
		throw lookupFailure(background, id, error);
	}
}
export async function runWait(
	background: TasksContext,
	input: TasksInput,
	signal?: AbortSignal,
	onReady?: (taskId: string) => void,
): Promise<AgentToolResult<TasksWaitDetails>> {
	const id = requireTaskId(input);
	try {
		const release = background.holdDelivery(id);
		try {
			const start = Date.now();
			const task = await background.wait(id, clampWaitMs(input.waitMs), signal);
			const timedOut = !isTaskTerminal(task.status);
			// A closed host resolves waits early without settling anything; do not claim
			// the execution merely outlived the wait window.
			const windowNote = background.closed
				? " · host closed; execution state unconfirmed"
				: timedOut
					? " · wait window expired; execution continues"
					: "";
			const sinceBytes = clampSinceBytes(input.sinceBytes);
			const slice = await background.read(id, { bytes: TASKS_WAIT_DELTA_BYTES, sinceBytes });
			signal?.throwIfAborted();
			if (!timedOut) onReady?.(task.id);
			return result(readText(`[${describeTaskLine(task)}${windowNote} · ${rangeText(slice, sinceBytes)}]`, slice), {
				action: "wait",
				taskId: task.id,
				status: task.status,
				kind: task.kind,
				timedOut,
				exitCode: task.exitCode,
				waitedMs: Date.now() - start,
				deltaBytes: Buffer.byteLength(slice.text),
				totalBytes: slice.totalBytes,
				deltaTruncated: slice.truncated,
				outputPath: task.outputPath ?? "",
			});
		} finally {
			release();
		}
	} catch (error) {
		throw lookupFailure(background, id, error);
	}
}
export function runKill(background: TasksContext, input: TasksInput): AgentToolResult<TasksKillDetails> {
	const id = requireTaskId(input);
	try {
		const task = background.get(id);
		const requested = background.kill(task.id);
		return result(
			requested
				? `Cancellation requested for ${task.id}. The task or whole group is stopping; cleanup may still be in progress.`
				: `No new cancellation requested for ${task.id} (${background.get(task.id).status}).`,
			{
				action: "kill",
				taskId: task.id,
				command: task.command ?? task.title,
				requested,
				status: background.get(task.id).status,
			},
		);
	} catch (error) {
		throw lookupFailure(background, id, error);
	}
}
export function runList(background: TasksContext): AgentToolResult<TasksListDetails> {
	const { tasks, foregroundOmitted } = listedTasks(background);
	const active = tasks.filter((task) => !isTaskTerminal(task.status));
	const finished = recentFinishedFirst(tasks.filter((task) => isTaskTerminal(task.status)));
	const shown = [...active, ...finished.slice(0, TASKS_LIST_FINISHED_SHOWN)].slice(0, 100);
	const hidden = tasks.length - shown.length;
	return result(
		shown.length
			? `${shown.map((task) => describeTaskLine(task)).join("\n")}${hidden > 0 ? `\n${hidden} more records not shown.` : ""}${foregroundOmissionNote(foregroundOmitted)}`
			: `No background tasks. Start work through its owning tool with background: true.${foregroundOmissionNote(foregroundOmitted)}`,
		{
			action: "list",
			running: active.length,
			finished: finished.length,
			shown: shown.length,
			hidden,
			...(foregroundOmitted > 0 ? { foregroundOmitted } : {}),
		},
	);
}
