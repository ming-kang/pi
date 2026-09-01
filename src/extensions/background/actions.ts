/**
 * background — the five `bg` actions.
 *
 * Free functions over the registry rather than closures over the extension's
 * session state: each action can be read, moved, and tested on its own, and
 * the required fields are narrowed at the top of each one (schema.ts) instead
 * of being asserted with a cast. Every model-facing tool-result string this
 * extension produces is built here.
 */

import type { AgentToolResult, ExtensionContext } from "../../core/extensions/types.ts";
import { resolveSpawnContext } from "../../core/tools/bash.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { BG_LIST_FINISHED_SHOWN, BG_WAIT_DELTA_BYTES, BG_WAIT_PEEK_BYTES } from "./constants.ts";
import { type OutputSlice, readOutputSince, readOutputSlice, readTail } from "./output-file.ts";
import type { BackgroundTaskRegistry, BgTask, ResolveTaskResult } from "./registry.ts";
import {
	type BgInput,
	clampReadBytes,
	clampSinceBytes,
	clampWaitMs,
	parseTimeoutSeconds,
	requireCommand,
	requireTaskId,
} from "./schema.ts";
import { exitSuffix, formatTaskCounts, hasExitCode, runtimeLabel, taskLabelWithin } from "./task-view.ts";
import { formatDuration, noticeLine } from "./text.ts";
import type { BgCreateDetails, BgKillDetails, BgListDetails, BgReadDetails, BgWaitDetails } from "./types.ts";

/** Width budget for a task label inside a listing row. */
const LIST_LABEL_WIDTH = 60;

function describeResolveFailure(input: string, result: ResolveTaskResult & { ok: false }): string {
	if (result.reason === "ambiguous") {
		const lines = result.candidates.map(
			(task) => `  ${task.id} (${task.status})  ${taskLabelWithin(task, LIST_LABEL_WIDTH)}`,
		);
		return `Task id "${input}" is ambiguous. Candidates:\n${lines.join("\n")}`;
	}
	return `No background task matches "${input}". Check the id returned by bg (action create), or run action list.`;
}

/** Resolve a task by id or unique prefix, or throw a message naming the next step. */
function resolveTask(registry: BackgroundTaskRegistry, taskId: string): BgTask {
	const resolved = registry.resolveTask(taskId);
	if (!resolved.ok) throw new Error(describeResolveFailure(taskId, resolved));
	return resolved.task;
}

/** One row of a bounded task listing: the model-facing list and the /bg fallback summary. */
export function describeTaskLine(task: BgTask, now: number): string {
	const label = taskLabelWithin(task, LIST_LABEL_WIDTH);
	return `  ${task.id}  ${task.status}${exitSuffix(task.exitCode, " ")}  ${runtimeLabel(task, now)}  ${label}`;
}

// ── create ────────────────────────────────────────────────────────────────

export function runCreate(
	registry: BackgroundTaskRegistry,
	input: BgInput,
	ctx: ExtensionContext,
): AgentToolResult<BgCreateDetails> {
	const command = requireCommand(input);
	const timeoutSeconds = parseTimeoutSeconds(input.timeout);
	// Same PI_* session variables as the built-in bash tool, snapshotted at start.
	const spawnContext = resolveSpawnContext(command, ctx.cwd, undefined, true, ctx);
	// Deliberately ignore the turn signal: aborting the current turn must not
	// kill the background task (that is what action kill is for).
	const task = registry.startTask({
		command,
		cwd: ctx.cwd,
		description: input.description,
		timeoutSeconds,
		env: spawnContext.env,
	});
	const label = task.description ? ` (${task.description})` : "";
	const text = [
		`Started background task ${task.id}${label}.`,
		`Output file: ${task.outputPath}`,
		"",
		"A <background-task> notification with the result and output tail arrives automatically when the task " +
			"ends — do NOT poll (no sleep loops, no repeated reads). Use action read for an early peek, " +
			"action wait when the next step depends on the result, action kill to stop it.",
	].join("\n");
	return {
		content: [{ type: "text", text }],
		details: {
			action: "create",
			taskId: task.id,
			outputPath: task.outputPath,
			command,
			description: input.description,
		},
	};
}

// ── read ──────────────────────────────────────────────────────────────────

export async function runRead(
	registry: BackgroundTaskRegistry,
	input: BgInput,
): Promise<AgentToolResult<BgReadDetails>> {
	const task = resolveTask(registry, requireTaskId(input));
	const mode = input.mode ?? "tail";
	let slice: OutputSlice;
	try {
		slice = await readOutputSlice(task.outputPath, { mode, maxBytes: clampReadBytes(input.bytes) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not read output for ${task.id} (${task.status}): ${message}\nOutput file: ${task.outputPath}`,
		);
	}
	const running = task.status === "running" && "still running";
	const notice = slice.truncated
		? noticeLine([
				`${mode} ${formatSize(slice.sliceBytes)} of ${formatSize(slice.totalBytes)}`,
				`task ${task.id} ${task.status}`,
				running,
				slice.startsMidLine && "first line may be partial",
				`full output: ${task.outputPath}`,
			])
		: noticeLine([
				`task ${task.id} ${task.status}`,
				running,
				`${formatSize(slice.totalBytes)} total`,
				`output: ${task.outputPath}`,
			]);
	const text = sanitizeBinaryOutput(slice.text);
	return {
		content: [{ type: "text", text: `${notice}\n${text.length > 0 ? text : "(no output yet)"}` }],
		details: {
			action: "read",
			taskId: task.id,
			mode,
			sliceBytes: slice.sliceBytes,
			totalBytes: slice.totalBytes,
			outputPath: task.outputPath,
		},
	};
}

// ── wait ──────────────────────────────────────────────────────────────────

/** The six fields every wait result shares; only the output accounting differs. */
function waitDetails(
	task: BgTask,
	waitedMs: number,
	output: { timedOut: boolean; deltaBytes: number; totalBytes: number; deltaTruncated: boolean },
): BgWaitDetails {
	return {
		action: "wait",
		taskId: task.id,
		status: task.status,
		exitCode: task.exitCode,
		outputPath: task.outputPath,
		waitedMs,
		...output,
	};
}

/** Header shared by a settled wait and by a settled wait whose output could not be read. */
function settledHeaderParts(task: BgTask, waitedMs: number): (string | false)[] {
	return [
		`${task.id} ${task.status}`,
		hasExitCode(task.exitCode) && `exit ${task.exitCode}`,
		`ran ${runtimeLabel(task)}`,
		`waited ${formatDuration(waitedMs)}`,
	];
}

export async function runWait(
	registry: BackgroundTaskRegistry,
	input: BgInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<BgWaitDetails>> {
	const task = resolveTask(registry, requireTaskId(input));
	const startedWait = Date.now();
	const result = await registry.waitForResult(task.id, clampWaitMs(input.waitMs), signal);
	const waitedMs = Date.now() - startedWait;
	return result.outcome === "timeout"
		? waitTimedOut(result.task, waitedMs)
		: waitSettled(result.task, waitedMs, clampSinceBytes(input.sinceBytes));
}

/** Window expired, task still running: keep progress visible with a bounded tail peek. */
async function waitTimedOut(task: BgTask, waitedMs: number): Promise<AgentToolResult<BgWaitDetails>> {
	const peek = await readTail(task.outputPath, BG_WAIT_PEEK_BYTES);
	const totalBytes = peek.slice?.totalBytes ?? task.outputBytes;
	const lines = [
		noticeLine([`${task.id} still running`, `waited ${formatDuration(waitedMs)}`, `${formatSize(totalBytes)} total`]),
	];
	const trimmed = sanitizeBinaryOutput(peek.slice?.text ?? "").trimEnd();
	if (trimmed.length > 0) {
		const note = peek.slice?.truncated ? ` (last ${formatSize(peek.slice.sliceBytes)})` : "";
		lines.push(`Last output${note}:\n${trimmed}`);
	}
	lines.push(
		"The task keeps running. Wait again (action wait), peek with action read, or stop it with action kill; " +
			"the <background-task> notification still arrives when it ends. Do not sleep-poll.",
	);
	return {
		content: [{ type: "text", text: lines.join("\n\n") }],
		details: waitDetails(task, waitedMs, { timedOut: true, deltaBytes: 0, totalBytes, deltaTruncated: false }),
	};
}

/**
 * Terminal: deliver the bounded delta since the requested offset. The followUp
 * notification was suppressed by the claim protocol — this result is the single
 * delivery of the completion, so it is produced even when the file is unreadable.
 */
async function waitSettled(
	task: BgTask,
	waitedMs: number,
	sinceBytes: number | undefined,
): Promise<AgentToolResult<BgWaitDetails>> {
	let delta: Awaited<ReturnType<typeof readOutputSince>>;
	try {
		delta = await readOutputSince(task.outputPath, sinceBytes ?? 0, BG_WAIT_DELTA_BYTES);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const notice = noticeLine(settledHeaderParts(task, waitedMs));
		return {
			content: [{ type: "text", text: `${notice}\nerror reading output: ${message}` }],
			details: waitDetails(task, waitedMs, {
				timedOut: false,
				deltaBytes: 0,
				totalBytes: task.outputBytes,
				deltaTruncated: false,
			}),
		};
	}

	const lines = [
		noticeLine([
			...settledHeaderParts(task, waitedMs),
			`+${formatSize(delta.sliceBytes)} new output`,
			`total ${formatSize(delta.totalBytes)}`,
		]),
	];
	if (delta.offsetPastEof) {
		lines.push(
			task.outputTruncated
				? "[the given offset is past EOF — output was truncated at the limit; showing the tail]"
				: "[the given offset is past EOF; showing the tail]",
		);
	}
	if (task.error) lines.push(`error: ${task.error}`);
	if (delta.truncated) {
		lines.push(
			`[showing ${formatSize(delta.sliceBytes)} of ${formatSize(delta.totalBytes)}; full output: ${task.outputPath}]`,
		);
	}
	const body = sanitizeBinaryOutput(delta.text).trimEnd();
	lines.push(body.length > 0 ? body : "(no new output)");
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: waitDetails(task, waitedMs, {
			timedOut: false,
			deltaBytes: delta.sliceBytes,
			totalBytes: delta.totalBytes,
			deltaTruncated: delta.truncated,
		}),
	};
}

// ── kill ──────────────────────────────────────────────────────────────────

export function runKill(registry: BackgroundTaskRegistry, input: BgInput): AgentToolResult<BgKillDetails> {
	const task = resolveTask(registry, requireTaskId(input));
	if (!registry.killTask(task.id).killed) {
		throw new Error(`Task ${task.id} is not running (status: ${task.status}${exitSuffix(task.exitCode, ", ")}).`);
	}
	return {
		content: [
			{
				type: "text",
				text: `Killed task ${task.id}. If you are waiting on it (action wait) the killed status is delivered there; otherwise a completion notification follows once the process tree is reaped.`,
			},
		],
		details: { action: "kill", taskId: task.id, command: task.command },
	};
}

// ── list ──────────────────────────────────────────────────────────────────

export function runList(registry: BackgroundTaskRegistry): AgentToolResult<BgListDetails> {
	const tasks = registry.listTasks();
	if (tasks.length === 0) {
		return {
			content: [{ type: "text", text: "No background tasks this session. Start one with action create." }],
			details: { action: "list", running: 0, finished: 0, shown: 0, hidden: 0 },
		};
	}
	const now = Date.now();
	const running = tasks.filter((task) => task.status === "running");
	const finished = tasks.filter((task) => task.status !== "running");
	const shownFinished = finished.slice(0, BG_LIST_FINISHED_SHOWN);
	const hidden = finished.length - shownFinished.length;
	const stalled = running.filter((task) => task.stalled).length;
	const lines = [formatTaskCounts({ running: running.length, stalled, total: tasks.length }) ?? "0 running"];
	for (const task of [...running, ...shownFinished]) {
		lines.push(describeTaskLine(task, now));
	}
	if (hidden > 0) {
		lines.push(`(+${hidden} more finished, not shown — action read shows any task's output)`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "list",
			running: running.length,
			finished: finished.length,
			shown: running.length + shownFinished.length,
			hidden,
		},
	};
}
