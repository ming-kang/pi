/**
 * The `tasks` tool's wire contract: one flat schema whose `action`
 * selects which of the remaining fields apply, plus the model-facing copy.
 *
 * The schema stays flat deliberately: a single tool keeps the model's tool list
 * short. Execution creation belongs to the native tools. Narrowing happens
 * inside actions.ts, not here.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { formatDuration } from "../../../core/tasks/format.ts";
import { TASK_RESULT_BYTES } from "../../../core/tasks/output.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import {
	TASKS_LOGS_DEFAULT_BYTES,
	TASKS_LOGS_MIN_BYTES,
	TASKS_WAIT_DEFAULT_MS,
	TASKS_WAIT_MAX_MS,
	TASKS_WAIT_MIN_MS,
} from "./constants.ts";

export const tasksSchema = Type.Object({
	action: StringEnum(["read", "wait", "kill", "list"] as const, {
		description: "Which task operation to perform",
	}),
	// — read / wait / kill —
	taskId: Type.Optional(
		Type.String({
			description: "Task execution id (read/wait/kill). Omit for wait to wait for any task running at call time.",
		}),
	),
	// — read —
	mode: Type.Optional(
		StringEnum(["tail", "head"] as const, {
			description: "Read from the end (default) or the start of the output (read)",
		}),
	),
	bytes: Type.Optional(
		Type.Number({
			description: `Max bytes to return (read, default ${formatSize(TASKS_LOGS_DEFAULT_BYTES)}, max ${formatSize(TASK_RESULT_BYTES)})`,
		}),
	),
	// — wait —
	waitMs: Type.Optional(
		Type.Number({
			description: `Maximum wait window in ms (default ${formatDuration(TASKS_WAIT_DEFAULT_MS)}, max ${formatDuration(TASKS_WAIT_MAX_MS)}). Only the wait ends on timeout; execution continues.`,
		}),
	),
	sinceBytes: Type.Optional(
		Type.Number({
			description:
				"Only return output written after this byte offset — use the 'next sinceBytes' value from a previous read or wait (wait with taskId only)",
		}),
	),
});

/** Raw tool arguments. Every per-action field is optional here; actions.ts narrows. */
export type TasksInput = Static<typeof tasksSchema>;

// ── reading the contract ──────────────────────────────────────────────────
// One place per field: required fields throw a message that names the next
// step, optional ones clamp to their documented range. Callers get plain
// values, so no action handler needs a cast.

export function requireTaskId(input: TasksInput): string {
	const taskId = input.taskId;
	if (!taskId || taskId.trim().length === 0) {
		throw new Error(`action '${input.action}' requires 'taskId' — use action list to find the execution id.`);
	}
	return taskId;
}

export function clampReadBytes(bytes: number | undefined): number {
	const value = bytes !== undefined && Number.isFinite(bytes) ? bytes : TASKS_LOGS_DEFAULT_BYTES;
	return Math.min(TASK_RESULT_BYTES, Math.max(TASKS_LOGS_MIN_BYTES, Math.floor(value)));
}

/** Shared with the pending-call renderer so the window it shows is the one that runs. */
export function clampWaitMs(waitMs: number | undefined): number {
	const value = waitMs !== undefined && Number.isFinite(waitMs) ? waitMs : TASKS_WAIT_DEFAULT_MS;
	return Math.min(TASKS_WAIT_MAX_MS, Math.max(TASKS_WAIT_MIN_MS, Math.floor(value)));
}

export function clampSinceBytes(sinceBytes: number | undefined): number | undefined {
	return sinceBytes === undefined || !Number.isFinite(sinceBytes) ? undefined : Math.max(0, Math.floor(sinceBytes));
}

export const TASKS_TOOL_DESCRIPTION =
	"Inspect and control background tasks started by native tools or extensions. " +
	"Completion is delivered to you automatically as a notification — never poll. " +
	"list: bounded activity/history listing; find task IDs here. " +
	"read: bounded model-readable output or report slice (head/tail); tool-call activity stays in /tasks. " +
	"wait: observe one task, or any task running at call time, for up to waitMs; no running tasks returns immediately. New steering input ends only the wait with outcome interrupted; it never stops the task. " +
	"kill: request cancellation of a whole task. " +
	"tasks cannot start work; submit background work through its owning tool. A wait ends as settled, interrupted, timed_out, or no_tasks. Timeout or cancellation ends only the wait, never execution. Reads and settled waits report byte ranges; use next sinceBytes only with that task's ID. Output is capped at 50KB per response.";
export const TASKS_PROMPT_SNIPPET = "Manage background tasks; wait for a specific task or any running task";
export const TASKS_PROMPT_GUIDELINES = [
	"Start background work through its owning tool with background: true; continue independent work while it runs.",
	"A finished background task delivers its result automatically as a notification. Use tasks wait only when your next step is blocked: provide taskId for one task or omit it for any task running at call time; never sleep-poll with repeated reads.",
	"A new steering message interrupts only an active tasks wait so you can read the new input; it does not cancel execution. A wait timeout is not a task failure.",
];
