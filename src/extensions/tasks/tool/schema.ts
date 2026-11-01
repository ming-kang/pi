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
import { TASKS_WAIT_DEFAULT_MS, TASKS_WAIT_MAX_MS } from "../../../core/tasks/limits.ts";
import { TASK_READ_BYTES, TASK_RESULT_BYTES } from "../../../core/tasks/output.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import { formatDuration } from "../../../utils/duration.ts";

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
			description:
				"Which end of the output to read (read). Defaults to the start of a report, such as an Agent's, and the end of a log, such as a command's",
		}),
	),
	bytes: Type.Optional(
		Type.Number({
			description: `Max bytes to return (read, default ${formatSize(TASK_READ_BYTES)}, max ${formatSize(TASK_RESULT_BYTES)})`,
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

export function clampSinceBytes(sinceBytes: number | undefined): number | undefined {
	return sinceBytes === undefined || !Number.isFinite(sinceBytes) ? undefined : Math.max(0, Math.floor(sinceBytes));
}

export const TASKS_TOOL_DESCRIPTION =
	"Inspect and control background tasks started by native tools or extensions. " +
	"Completion is delivered to you automatically and starts a new turn if yours has ended — never poll; end your turn instead of waiting. " +
	"list: bounded activity/history listing; find task IDs here. " +
	"read: bounded model-readable output or report slice (head/tail, by default a report from its start and a log from its end); tool-call activity stays in /tasks. " +
	"wait: observe one task, or any task running at call time, for up to waitMs; no running tasks returns immediately. New steering input ends only the wait with outcome interrupted; it never stops the task. " +
	"kill: request cancellation of a whole task. " +
	"tasks cannot start work; submit background work through its owning tool. A wait ends as settled, interrupted, timed_out, or no_tasks. Timeout or cancellation ends only the wait, never execution. Reads and settled waits report byte ranges; use next sinceBytes only with that task's ID. Output is capped at 50KB per response.";
export const TASKS_PROMPT_SNIPPET = "List, read, or stop background tasks; their results arrive automatically";
export const TASKS_PROMPT_GUIDELINES = [
	"Start background work through its owning tool with background: true; continue independent work while it runs.",
	"Ending your turn is the normal way to wait for a background task: when it finishes, its result starts a new turn for you automatically. Do not use tasks wait to get a result; use it only when the user explicitly asks you to block on a task, with taskId for one task or without it for any task running at call time. Never poll with repeated waits or reads.",
	"A new steering message interrupts only an active tasks wait so you can read the new input; it does not cancel execution. A wait timeout is not a task failure.",
];
