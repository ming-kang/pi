import type { CustomMessage } from "../messages.ts";
import { truncateHead, truncateTail } from "../tools/truncate.ts";
import { boundTail, boundText, TASK_DETAILS_BYTES, TASK_RESULT_BYTES, TASK_TITLE_BYTES } from "./output.ts";
import type { TaskCompletionSnapshot, TaskSnapshot, TaskTerminalStatus, TaskText } from "./types.ts";

const OUTPUT_BYTES = 40 * 1024;
const MODEL_LINES = 2000;

/** Read data properties only, including at the persisted-message boundary. */
function object(value: unknown): object {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected snapshot object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected plain snapshot");
	return value;
}

function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !("value" in descriptor)) throw new Error("Unexpected snapshot accessor");
	return descriptor?.value;
}

/** Bound escaped JSON as well as UTF-8, without serializing an unbounded source. */
function string(value: unknown, bytes: number): string {
	if (typeof value !== "string") throw new Error("Expected snapshot text");
	const prefix = boundText(value, bytes - 2);
	if (Buffer.byteLength(JSON.stringify(prefix)) <= bytes) return prefix;
	let low = 0;
	let high = Buffer.byteLength(prefix);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(JSON.stringify(boundText(prefix, middle))) <= bytes) low = middle;
		else high = middle - 1;
	}
	return boundText(prefix, low);
}

/** The end of a text whose escaped JSON fits `bytes`: a command's outcome is at its end. */
function tail(value: string, bytes: number): TaskText {
	const fits = (size: number) => Buffer.byteLength(JSON.stringify(boundTail(value, size).text)) <= bytes;
	let low = 0;
	let high = Buffer.byteLength(value);
	if (fits(high)) return { text: value, truncated: false };
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	return boundTail(value, low);
}

function optionalString(source: object, key: string, bytes: number): string | undefined {
	const value = field(source, key);
	return value === undefined ? undefined : string(value, bytes);
}

function text(value: unknown, bytes: number): TaskText {
	const source = object(value);
	const original = field(source, "text");
	const truncated = field(source, "truncated");
	if (typeof truncated !== "boolean") throw new Error("Expected truncation flag");
	const bounded = string(original, bytes);
	return { text: bounded, truncated: truncated || bounded !== original };
}

function terminalStatus(value: unknown): TaskTerminalStatus {
	if (
		value === "completed" ||
		value === "partial" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "timeout"
	)
		return value;
	throw new Error("Expected terminal status");
}

/** Only this format is understood. Invalid/older details receive the renderer's bounded plain-text fallback. */
export function readTaskCompletion(value: unknown): TaskCompletionSnapshot | undefined {
	try {
		const source = object(value);
		if (field(source, "version") !== 2) return undefined;
		const taskId = field(source, "taskId");
		const kind = field(source, "kind");
		if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) return undefined;
		if (
			typeof taskId !== "string" ||
			!taskId.startsWith(`${kind}-`) ||
			taskId.length <= kind.length + 1 ||
			taskId.length > 512 ||
			Buffer.byteLength(taskId) > 512 ||
			taskId.includes("\0")
		)
			return undefined;
		const startedAt = field(source, "startedAt");
		const endedAt = field(source, "endedAt");
		if (
			typeof startedAt !== "number" ||
			!Number.isSafeInteger(startedAt) ||
			startedAt < 0 ||
			typeof endedAt !== "number" ||
			!Number.isSafeInteger(endedAt) ||
			endedAt < startedAt
		)
			return undefined;
		const command = field(source, "command");
		const outputPath = field(source, "outputPath");
		const exitCode = field(source, "exitCode");
		if (
			exitCode !== undefined &&
			exitCode !== null &&
			(typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))
		)
			return undefined;
		// A clipped path would name a different file. Omit oversized paths intact.
		if (outputPath !== undefined && typeof outputPath !== "string") return undefined;
		const snapshot: TaskCompletionSnapshot = {
			version: 2,
			kind,
			taskId,
			title: string(field(source, "title"), TASK_TITLE_BYTES),
			status: terminalStatus(field(source, "status")),
			startedAt,
			endedAt,
			error: optionalString(source, "error", 4096),
			command: command === undefined ? undefined : text(command, 8192),
			cwd: optionalString(source, "cwd", 4096),
			outputPath:
				outputPath &&
				!outputPath.includes("\0") &&
				outputPath.length <= 8192 &&
				Buffer.byteLength(JSON.stringify(outputPath)) <= 8192
					? outputPath
					: undefined,
			...(exitCode !== undefined ? { exitCode } : {}),
			output: text(field(source, "output"), OUTPUT_BYTES),
		};
		return Buffer.byteLength(JSON.stringify(snapshot)) <= TASK_DETAILS_BYTES ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

export function taskCompletionSnapshot(task: TaskSnapshot): TaskCompletionSnapshot {
	const result =
		task.result?.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n") ?? "";
	const output = tail(result, OUTPUT_BYTES);
	const snapshot = readTaskCompletion({
		version: 2,
		kind: task.kind,
		taskId: task.id,
		title: task.title,
		status: task.status,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		error: task.error,
		command:
			task.command === undefined ? undefined : { text: task.command, truncated: task.commandTruncated ?? false },
		cwd: task.cwd,
		outputPath: task.outputPath,
		...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
		output: { text: output.text, truncated: output.truncated || (task.resultTruncated ?? false) },
	});
	if (!snapshot) throw new Error("Invalid task completion snapshot");
	return snapshot;
}

const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();
const OMISSION = "\n[Saved output truncated; use tasks read for retained task details.]";

function modelText(value: TaskText, bytes: number, lines: number): string {
	const result = truncateHead(value.text, {
		maxBytes: Math.max(0, bytes - Buffer.byteLength(OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return result.content + (value.truncated || result.truncated ? OMISSION : "");
}

const EARLIER_OMISSION = "[Earlier output truncated; use tasks read for retained task details.]\n";

/** Output keeps its end, where the outcome is. */
function modelTail(value: TaskText, bytes: number, lines: number): string {
	const result = truncateTail(value.text, {
		maxBytes: Math.max(0, bytes - Buffer.byteLength(EARLIER_OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return (value.truncated || result.truncated ? EARLIER_OMISSION : "") + result.content;
}

/** One bounded action hint per terminal outcome; completed work needs none. */
function nextStepLine(status: TaskTerminalStatus): string {
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

/** The context and the card share facts; only the context receives this prose projection. */
function notificationText(snapshot: TaskCompletionSnapshot): string {
	const header = [
		`Background ${snapshot.kind} ${snapshot.taskId}: ${snapshot.status}${snapshot.command ? "" : ` — ${singleLine(snapshot.title)}`}`,
		snapshot.error ? `Error: ${singleLine(snapshot.error)}` : "",
	].filter(Boolean);
	if (snapshot.command) header.push(`Command:\n${modelText(snapshot.command, 8192, 128)}`);
	if (snapshot.cwd) header.push(`cwd: ${singleLine(snapshot.cwd)}`);
	if (snapshot.outputPath) header.push(`Output: ${singleLine(snapshot.outputPath)}`);
	const prefix = `${header.join("\n")}\n\n`;
	const guidance = nextStepLine(snapshot.status);
	const suffix = guidance ? `\n\n${guidance}` : "";
	const remaining = TASK_RESULT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
	const lines = MODEL_LINES - prefix.split("\n").length - (guidance ? 3 : 0);
	const output = snapshot.output.text ? snapshot.output : { text: "No text result.", truncated: false };
	return prefix + modelTail(output, remaining, lines) + suffix;
}

export function taskCompletionMessage(task: TaskSnapshot): CustomMessage<TaskCompletionSnapshot> {
	const details = taskCompletionSnapshot(task);
	return {
		role: "custom",
		customType: "task-completion",
		display: true,
		content: notificationText(details),
		details,
		timestamp: Date.now(),
	};
}
