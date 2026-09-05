/** Management only: execution and delivery belong to the session Background service. */
import { boundText } from "../../core/background/output.ts";
import {
	type BackgroundContext,
	type BackgroundRead,
	type BackgroundTask,
	isBackgroundTerminal,
} from "../../core/background/types.ts";
import type { AgentToolResult } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { BG_LIST_FINISHED_SHOWN, BG_WAIT_DELTA_BYTES } from "./constants.ts";
import { type BgInput, clampReadBytes, clampSinceBytes, clampWaitMs, requireTaskId } from "./schema.ts";
import { runtimeLabel } from "./task-view.ts";
import type { BgDetails, BgKillDetails, BgListDetails, BgReadDetails, BgWaitDetails } from "./types.ts";

export function boundedText(text: string): string {
	return truncateHead(sanitizeBinaryOutput(text), { maxBytes: 50 * 1024, maxLines: 2000 }).content;
}
function result<T extends BgDetails>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text: boundedText(text) }], details };
}
export function describeTaskLine(task: BackgroundTask, now = Date.now()): string {
	return `${task.id} ${task.kind} ${task.status} (${task.mode}) ${runtimeLabel(task, now)} ${task.title.slice(0, 200)}`;
}
/** Reserve space for each independent diagnostic before allowing raw output to fill the budget. */
function readText(header: string, slice: BackgroundRead): string {
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
export async function runRead(background: BackgroundContext, input: BgInput): Promise<AgentToolResult<BgReadDetails>> {
	const mode = input.mode ?? "tail";
	const slice = await background.read(requireTaskId(input), { mode, bytes: clampReadBytes(input.bytes) });
	return result(
		readText(
			`[${describeTaskLine(slice.task)} · ${slice.totalBytes} bytes${slice.truncated ? " · truncated" : ""}]`,
			slice,
		),
		{
			action: "read",
			taskId: slice.task.id,
			mode,
			sliceBytes: Buffer.byteLength(slice.text),
			totalBytes: slice.totalBytes,
			outputPath: slice.task.outputPath ?? "",
			kind: slice.task.kind,
			status: slice.task.status,
		},
	);
}
export async function runWait(
	background: BackgroundContext,
	input: BgInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<BgWaitDetails>> {
	const id = requireTaskId(input);
	const release = background.pin(id);
	try {
		const start = Date.now();
		const task = await background.wait(id, clampWaitMs(input.waitMs), signal);
		const timedOut = !isBackgroundTerminal(task.status);
		const slice = await background.read(id, {
			bytes: BG_WAIT_DELTA_BYTES,
			sinceBytes: clampSinceBytes(input.sinceBytes),
		});
		signal?.throwIfAborted();
		return result(
			readText(`[${describeTaskLine(task)}${timedOut ? " · wait window expired; execution continues" : ""}]`, slice),
			{
				action: "wait",
				taskId: task.id,
				...(!timedOut ? { backgroundTaskId: task.id } : {}),
				status: task.status,
				kind: task.kind,
				timedOut,
				exitCode: undefined,
				waitedMs: Date.now() - start,
				deltaBytes: Buffer.byteLength(slice.text),
				totalBytes: slice.totalBytes,
				deltaTruncated: slice.truncated,
				outputPath: task.outputPath ?? "",
			},
		);
	} finally {
		release();
	}
}
export function runKill(background: BackgroundContext, input: BgInput): AgentToolResult<BgKillDetails> {
	const task = background.get(requireTaskId(input));
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
}
export function runList(background: BackgroundContext): AgentToolResult<BgListDetails> {
	const tasks = background.list();
	const active = tasks.filter((task) => !isBackgroundTerminal(task.status));
	const finished = tasks.filter((task) => isBackgroundTerminal(task.status));
	const shown = [...active, ...finished.slice(0, BG_LIST_FINISHED_SHOWN)].slice(0, 100);
	return result(
		shown.length
			? `${shown.map((task) => describeTaskLine(task)).join("\n")}\n${tasks.length - shown.length} more records not shown.`
			: "No managed executions. Start work through bash or subagent with background: true.",
		{
			action: "list",
			running: active.length,
			finished: finished.length,
			shown: shown.length,
			hidden: tasks.length - shown.length,
		},
	);
}
