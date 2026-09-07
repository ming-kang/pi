/**
 * background — the `bg` tool's wire contract: one flat schema whose `action`
 * selects which of the remaining fields apply, plus the model-facing copy.
 *
 * The schema stays flat deliberately: a single tool keeps the model's tool list
 * short. Execution creation belongs to the native tools. Narrowing happens
 * inside actions.ts, not here.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import {
	BG_LOGS_DEFAULT_BYTES,
	BG_LOGS_MIN_BYTES,
	BG_WAIT_DEFAULT_MS,
	BG_WAIT_MAX_MS,
	BG_WAIT_MIN_MS,
} from "./constants.ts";

export const bgSchema = Type.Object({
	action: StringEnum(["read", "wait", "kill", "list"] as const, {
		description: "Which background-task operation to perform",
	}),
	// — read / wait / kill —
	taskId: Type.Optional(Type.String({ description: "Bash task or Subagent group id (read/wait/kill)" })),
	// — read —
	mode: Type.Optional(
		StringEnum(["tail", "head"] as const, {
			description: "Read from the end (default) or the start of the output (read)",
		}),
	),
	bytes: Type.Optional(
		Type.Number({
			description: `Max bytes to return (read, default ${formatSize(BG_LOGS_DEFAULT_BYTES)}, max ${formatSize(DEFAULT_MAX_BYTES)})`,
		}),
	),
	// — wait —
	waitMs: Type.Optional(
		Type.Number({
			description: `Max time to wait in ms, default ${BG_WAIT_DEFAULT_MS}, max ${BG_WAIT_MAX_MS} (wait)`,
		}),
	),
	sinceBytes: Type.Optional(
		Type.Number({
			description:
				"Only return output written after this byte offset — take it from a previous read/wait result (wait)",
		}),
	),
});

/** Raw tool arguments. Every per-action field is optional here; actions.ts narrows. */
export type BgInput = Static<typeof bgSchema>;

// ── reading the contract ──────────────────────────────────────────────────
// One place per field: required fields throw a message that names the next
// step, optional ones clamp to their documented range. Callers get plain
// values, so no action handler needs a cast.

export function requireTaskId(input: BgInput): string {
	const taskId = input.taskId;
	if (!taskId || taskId.trim().length === 0) {
		throw new Error(`action '${input.action}' requires 'taskId' — use action list to find the execution id.`);
	}
	return taskId;
}

export function clampReadBytes(bytes: number | undefined): number {
	const value = bytes !== undefined && Number.isFinite(bytes) ? bytes : BG_LOGS_DEFAULT_BYTES;
	return Math.min(DEFAULT_MAX_BYTES, Math.max(BG_LOGS_MIN_BYTES, Math.floor(value)));
}

/** Shared with the pending-call renderer so the window it shows is the one that runs. */
export function clampWaitMs(waitMs: number | undefined): number {
	const value = waitMs !== undefined && Number.isFinite(waitMs) ? waitMs : BG_WAIT_DEFAULT_MS;
	return Math.min(BG_WAIT_MAX_MS, Math.max(BG_WAIT_MIN_MS, Math.floor(value)));
}

export function clampSinceBytes(sinceBytes: number | undefined): number | undefined {
	return sinceBytes === undefined || !Number.isFinite(sinceBytes) ? undefined : Math.max(0, Math.floor(sinceBytes));
}

export const BG_TOOL_DESCRIPTION =
	"Inspect and control backgrounded work: Bash tasks and Subagent groups started with background: true. " +
	"Completion is delivered to you automatically as a notification — never poll. " +
	"list: bounded activity/history listing; find task IDs here. " +
	"read: bounded output or report slice (head/tail). " +
	"wait: block up to waitMs for a task to settle; cancelling the wait ends only the wait, never the task. " +
	"kill: request cancellation of a task or a whole Subagent group, never an individual worker. " +
	"bg cannot start work; pass background: true to bash or subagent. Output is capped at 50KB per response.";
export const BG_PROMPT_SNIPPET = "Manage Bash tasks and Subagent groups (list, read, wait, kill)";
export const BG_PROMPT_GUIDELINES = [
	"Start background work through bash or subagent with background: true; continue independent work while it runs.",
	"A finished background task delivers its result automatically as a notification; use bg wait only when your next step is blocked on it, and never sleep-poll with repeated reads.",
];
