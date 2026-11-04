/**
 * The `tasks` tool's wire contract: one flat schema whose `action`
 * selects which of the remaining fields apply, plus the model-facing copy.
 *
 * The schema stays flat deliberately: a single tool keeps the model's tool list
 * short. Execution creation belongs to the native tools. Narrowing happens
 * inside actions.ts, not here.
 */

import { type Static, Type } from "typebox";
import { StringEnum } from "../../../core/extensions/pi-ai-extension-view.ts";
import { TASK_READ_BYTES, TASK_RESULT_BYTES } from "../../../core/tasks/output.ts";
import { formatSize } from "../../../core/tools/truncate.ts";

export const tasksSchema = Type.Object({
	action: StringEnum(["read", "kill", "list"] as const, {
		description: "Which task operation to perform",
	}),
	// — read / kill —
	taskId: Type.Optional(
		Type.String({
			description: "Task execution id (read/kill).",
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
	sinceBytes: Type.Optional(
		Type.Number({
			description:
				"Only return output written after this byte offset — use the 'next sinceBytes' value from a previous read (read)",
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
	"`list` shows task IDs with bounded activity and history; `read` returns a bounded output or report slice; `kill` requests cancellation. ";
export const TASKS_PROMPT_SNIPPET = "List, read, or stop background tasks";
export const TASKS_PROMPT_GUIDELINES = [
	"`tasks` cannot start work: start background work through its owning tool with `background: true`, then continue independent work while it runs.",
	"Ending your turn is the way to wait for a background task: when it finishes, its result starts a new turn for you automatically. Never poll `tasks` with repeated `list` or `read` calls.",
];
