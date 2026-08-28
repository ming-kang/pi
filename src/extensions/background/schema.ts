/**
 * background — the `bg` tool's wire contract: one flat schema whose `action`
 * selects which of the remaining fields apply, plus the model-facing copy.
 *
 * The schema stays flat deliberately: a single tool keeps the model's tool list
 * short (the five operations were merged for that reason). Narrowing happens
 * inside actions.ts, not here.
 */

import { type Static, Type } from "typebox";
import { MAX_TIMEOUT_SECONDS } from "../../core/tools/bash.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import {
	BG_LOGS_DEFAULT_BYTES,
	BG_LOGS_MIN_BYTES,
	BG_WAIT_DEFAULT_MS,
	BG_WAIT_MAX_MS,
	BG_WAIT_MIN_MS,
} from "./constants.ts";

export const bgSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("create"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
		{ description: "Which background-task operation to perform" },
	),
	// — create —
	command: Type.Optional(
		Type.String({ description: "Bash command to run in the background (create). Do not append '&'" }),
	),
	description: Type.Optional(
		Type.String({
			description: "Short label for the task, shown in /bg and notifications, e.g. 'dev server' (create)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Kill the task after this many seconds; on expiry it is reported as timeout (create)",
		}),
	),
	// — read / wait / kill —
	taskId: Type.Optional(
		Type.String({ description: "Task id; a unique prefix is accepted, e.g. 'bg-3f' or '3f' (read/wait/kill)" }),
	),
	// — read —
	mode: Type.Optional(
		Type.Union([Type.Literal("tail"), Type.Literal("head")], {
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

export function requireCommand(input: BgInput): string {
	const command = input.command;
	if (!command || command.trim().length === 0) {
		throw new Error("action 'create' requires 'command' — pass the bash command to run in the background.");
	}
	return command;
}

export function requireTaskId(input: BgInput): string {
	const taskId = input.taskId;
	if (!taskId || taskId.trim().length === 0) {
		throw new Error(
			`action '${input.action}' requires 'taskId' — use the id returned by action create, or action list to find it.`,
		);
	}
	return taskId;
}

/** Rejected before a task is started, so an invalid timeout never spawns anything. */
export function parseTimeoutSeconds(timeout: number | undefined): number | undefined {
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
		throw new Error("Invalid timeout: must be a positive number of seconds.");
	}
	if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeout;
}

export function clampReadBytes(bytes: number | undefined): number {
	return Math.min(DEFAULT_MAX_BYTES, Math.max(BG_LOGS_MIN_BYTES, Math.floor(bytes ?? BG_LOGS_DEFAULT_BYTES)));
}

/** Shared with the pending-call renderer so the window it shows is the one that runs. */
export function clampWaitMs(waitMs: number | undefined): number {
	return Math.min(BG_WAIT_MAX_MS, Math.max(BG_WAIT_MIN_MS, Math.floor(waitMs ?? BG_WAIT_DEFAULT_MS)));
}

export function clampSinceBytes(sinceBytes: number | undefined): number | undefined {
	return sinceBytes === undefined ? undefined : Math.max(0, Math.floor(sinceBytes));
}

export const BG_TOOL_DESCRIPTION =
	"Run and manage background bash tasks.\n\n" +
	"create: start a command in the background and return immediately with a task id and an " +
	"output file path. A <background-task> notification with status, exit code, and output tail " +
	"arrives automatically when it ends. Do NOT append '&' to the command; bg already runs it " +
	"detached.\n\n" +
	"read: bounded slice of a task's output; works while the task runs. The " +
	"output file is a plain file — the read tool also works on it for line-based paging.\n\n" +
	"wait: block until a task finishes and return its status plus output written since a given " +
	"offset. On timeout the task is still running and you may wait again.\n\n" +
	"kill: stop a running task (whole process tree).\n\n" +
	"list: currently known tasks with status.";

export const BG_PROMPT_SNIPPET = "Manage background shell tasks (create, read, wait, kill, list)";

export const BG_PROMPT_GUIDELINES = [
	"Use `bg` action create for long-running commands (dev servers, watch builds, slow tests) instead of regular bash; the completion notification arrives on its own, so continue independent work or end the turn.",
	"Never wait on a `bg` task with sleep loops or repeated reads; use `bg` action wait when the next step depends on its result.",
];
