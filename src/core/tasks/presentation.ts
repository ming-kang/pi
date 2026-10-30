import type { CustomMessage } from "../messages.ts";
import { truncateHead, truncateTail } from "../tools/truncate.ts";
import { TASK_SNAPSHOT_VERSION } from "./codec.ts";
import { boundTail, boundText, TASK_DETAILS_BYTES, TASK_RESULT_BYTES } from "./output.ts";
import type { TaskSnapshot, TaskStatus, TaskText } from "./types.ts";

/** Automatic model turns get only a small readable log tail; reports arrive whole. */
const MODEL_LOG_BYTES = 8 * 1024;
const MODEL_LINES = 2000;
/** Replay copies of the output and input inside completion details. */
const REPLAY_OUTPUT_BYTES = [40 * 1024, 16 * 1024, 4 * 1024, 0] as const;
const REPLAY_INPUT_BYTES = 8 * 1024;

export interface TaskCompletionDetails {
	version: typeof TASK_SNAPSHOT_VERSION;
	task: TaskSnapshot;
}

const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();
const bytes = (value: string) => Buffer.byteLength(value);

const OMISSION = "\n[Saved output truncated; use tasks read for retained task details.]";
const EARLIER_OMISSION = "[Earlier output truncated; use tasks read for retained task details.]\n";

/** A report keeps its beginning, where its summary is. */
function modelHead(value: TaskText, maxBytes: number, lines: number): string {
	const result = truncateHead(value.text, {
		maxBytes: Math.max(0, maxBytes - bytes(OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return result.content + (value.truncated || result.truncated ? OMISSION : "");
}

/** A log keeps its end, where the outcome is. */
function modelTail(value: TaskText, maxBytes: number, lines: number): string {
	const result = truncateTail(value.text, {
		maxBytes: Math.max(0, maxBytes - bytes(EARLIER_OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return (value.truncated || result.truncated ? EARLIER_OMISSION : "") + result.content;
}

/** One bounded action hint per terminal outcome; completed work needs none. */
function nextStepLine(status: TaskStatus): string {
	switch (status) {
		case "cancelled":
			return "Next step: the task was cancelled — do not restart it unless the user asks.";
		case "timeout":
			return "Next step: the task hit its timeout; inspect the partial output above, then rerun with a longer timeout or in smaller pieces if still needed.";
		case "failed":
		case "partial":
			return "Next step: diagnose from the output above before retrying; rerun only what is still needed.";
		default:
			return "";
	}
}

/**
 * The model-facing text of a settled background task. A report reaches the model as its
 * foreground result would have; a log contributes only its tail to the automatic turn.
 */
export function projectForModel(task: TaskSnapshot): string {
	const header = [
		boundText(`Background ${task.kind} ${task.id}: ${task.status} — ${singleLine(task.title)}`, 2048),
		task.error ? `Error: ${singleLine(task.error)}` : "",
		...(task.facts ?? []).map(([label, value]) => `${label}: ${singleLine(value)}`),
		task.outputPath ? `Output: ${singleLine(task.outputPath)}` : "",
	].filter(Boolean);
	const prefix = `${header.join("\n")}\n\n`;
	const guidance = nextStepLine(task.status);
	const suffix = guidance ? `\n\n${guidance}` : "";
	const budget = TASK_RESULT_BYTES - bytes(prefix) - bytes(suffix);
	const lines = MODEL_LINES - prefix.split("\n").length - (guidance ? 3 : 0);
	const output = task.result?.text ? task.result : { text: "No text result.", truncated: false };
	const body =
		task.output === "report"
			? modelHead(output, budget, lines)
			: modelTail(output, Math.min(MODEL_LOG_BYTES, budget), lines);
	return prefix + body + suffix;
}

function clipped(value: TaskText, maxBytes: number, keep: "head" | "tail"): TaskText {
	const text = keep === "head" ? boundText(value.text, maxBytes) : boundTail(value.text, maxBytes).text;
	return { text, truncated: value.truncated || text !== value.text };
}

/** A self-contained replay snapshot within the details budget; human-only display stays in the session record. */
export function taskCompletionDetails(task: TaskSnapshot): TaskCompletionDetails {
	const { display: _display, result, input, ...rest } = task;
	const keep = task.output === "report" ? "head" : "tail";
	const replayInput = input && { ...input, ...clipped(input, REPLAY_INPUT_BYTES, "head") };
	for (const outputBytes of REPLAY_OUTPUT_BYTES) {
		const details: TaskCompletionDetails = {
			version: TASK_SNAPSHOT_VERSION,
			task: {
				...rest,
				...(replayInput ? { input: replayInput } : {}),
				...(result && outputBytes > 0 ? { result: clipped(result, outputBytes, keep) } : {}),
			},
		};
		if (bytes(JSON.stringify(details)) <= TASK_DETAILS_BYTES) return details;
	}
	return { version: TASK_SNAPSHOT_VERSION, task: rest };
}

export function taskCompletionMessage(task: TaskSnapshot): CustomMessage<TaskCompletionDetails> {
	return {
		role: "custom",
		customType: "task-completion",
		display: true,
		content: projectForModel(task),
		details: taskCompletionDetails(task),
		timestamp: Date.now(),
	};
}
