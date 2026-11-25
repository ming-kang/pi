/** Management only: execution and delivery belong to the session task runtime. */

import type { AgentToolResult } from "../../../core/extensions/types.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { clampReadBytes, defaultReadMode } from "../../../core/tasks/limits.ts";
import { boundText, taskReadBytes, taskReadRange } from "../../../core/tasks/output.ts";
import {
	isTaskTerminal,
	TaskLookupError,
	type TaskRead,
	type TaskSnapshot,
	type TasksContext,
} from "../../../core/tasks/types.ts";
import { truncateHead } from "../../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { clampContextLines, clampFinishedLimit, clampSinceBytes, requireTaskId, type TasksInput } from "./schema.ts";
import type { TasksDetails, TasksKillDetails, TasksListDetails, TasksReadDetails } from "./types.ts";

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
 * Where this slice sits in the output, so the next read can continue from it.
 * A tail read whose new output exceeds its budget returns the newest bytes and says what it skipped.
 */
function rangeText(slice: TaskRead, sinceBytes?: number, filter?: string): string {
	const { from, to } = taskReadRange(slice);
	const floor = sinceBytes === undefined || sinceBytes > slice.totalBytes ? 0 : sinceBytes;
	if (slice.filtered) {
		const matches = slice.totalMatches ?? 0;
		return [
			filter ? `filter "${filter}"` : "filtered",
			`${matches} ${matches === 1 ? "match" : "matches"}`,
			`bytes ${from}–${to} of ${slice.totalBytes}`,
			`next sinceBytes ${to}`,
		].join(" · ");
	}
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
	const facts = slice.task.facts?.length
		? `Facts: ${boundedField(slice.task.facts.map(([label, value]) => `${label}=${value}`).join(" · "), 4096)}`
		: "";
	return [
		boundedField(header, 4096),
		slice.task.error ? `Task error: ${boundedField(slice.task.error, 4096)}` : "",
		slice.readError ? `Output read error: ${boundedField(slice.readError, 4096)}` : "",
		facts,
		boundedField(slice.task.outputPath ?? "", 8192),
		slice.text || (slice.filtered ? "(no matching lines)" : "(no output yet)"),
	]
		.filter(Boolean)
		.join("\n");
}
export async function runRead(background: TasksContext, input: TasksInput): Promise<AgentToolResult<TasksReadDetails>> {
	const id = requireTaskId(input);
	try {
		const sinceBytes = clampSinceBytes(input.sinceBytes);
		const filter = input.filter?.trim() || undefined;
		const contextLines = clampContextLines(input.contextLines);
		const slice = await background.read(id, {
			mode: input.mode,
			bytes: clampReadBytes(input.bytes),
			sinceBytes,
			filter,
			contextLines,
		});
		// The runtime resolved an omitted mode from this same snapshot, so report what it actually used.
		const mode = input.mode ?? defaultReadMode(slice.task);
		return result(readText(`[${describeTaskLine(slice.task)} · ${rangeText(slice, sinceBytes, filter)}]`, slice), {
			action: "read",
			taskId: slice.task.id,
			mode,
			sliceBytes: taskReadBytes(slice),
			totalBytes: slice.totalBytes,
			outputPath: slice.task.outputPath ?? "",
			kind: slice.task.kind,
			status: slice.task.status,
			...(slice.filtered ? { filter, totalMatches: slice.totalMatches ?? 0 } : {}),
		});
	} catch (error) {
		throw lookupFailure(background, id, error);
	}
}

export function runKill(background: TasksContext, input: TasksInput): AgentToolResult<TasksKillDetails> {
	const id = requireTaskId(input);
	try {
		const before = background.get(id);
		const requested = background.kill(before.id);
		const after = background.get(before.id);
		return result(
			requested
				? `Cancellation requested for ${before.id}. The task or whole group is stopping; cleanup may still be in progress.`
				: `No new cancellation requested for ${before.id} (${after.status}).`,
			{
				action: "kill",
				taskId: before.id,
				title: before.title,
				requested,
				status: after.status,
			},
		);
	} catch (error) {
		throw lookupFailure(background, id, error);
	}
}
export function runList(background: TasksContext, input?: TasksInput): AgentToolResult<TasksListDetails> {
	const { tasks, foregroundOmitted } = listedTasks(background);
	const active = tasks.filter((task) => !isTaskTerminal(task.status));
	const finished = recentFinishedFirst(tasks.filter((task) => isTaskTerminal(task.status)));
	const status = input?.status ?? "all";
	const finishedLimit = clampFinishedLimit(input?.limit);
	const shown =
		status === "active"
			? active.slice(0, 100)
			: status === "finished"
				? finished.slice(0, finishedLimit)
				: [...active, ...finished.slice(0, finishedLimit)].slice(0, 100);
	const poolSize = status === "active" ? active.length : status === "finished" ? finished.length : tasks.length;
	const hidden = poolSize - shown.length;
	let emptyText: string;
	if (status === "active") {
		emptyText = `No active background tasks.${finished.length > 0 ? ` (${finished.length} finished.)` : ""}${foregroundOmissionNote(foregroundOmitted)}`;
	} else if (status === "finished") {
		emptyText =
			hidden > 0
				? `${hidden} more records not shown.${foregroundOmissionNote(foregroundOmitted)}`
				: `No finished background tasks.${active.length > 0 ? ` (${active.length} active.)` : ""}${foregroundOmissionNote(foregroundOmitted)}`;
	} else {
		emptyText =
			hidden > 0
				? `No active background tasks.\n${hidden} more records not shown.${foregroundOmissionNote(foregroundOmitted)}`
				: `No background tasks. Start work through its owning tool with background: true.${foregroundOmissionNote(foregroundOmitted)}`;
	}
	return result(
		shown.length
			? `${shown.map((task) => describeTaskLine(task)).join("\n")}${hidden > 0 ? `\n${hidden} more records not shown.` : ""}${foregroundOmissionNote(foregroundOmitted)}`
			: emptyText,
		{
			action: "list",
			running: active.length,
			finished: finished.length,
			shown: shown.length,
			hidden,
			...(foregroundOmitted > 0 ? { foregroundOmitted } : {}),
			...(input?.status ? { status: input.status } : {}),
		},
	);
}
