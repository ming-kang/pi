import { open } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { finiteLimit } from "../../utils/number.ts";
import type { TaskActivity, TaskDisplay, TaskFact, TaskInput, TaskRead, TaskReadOptions, TaskText } from "./types.ts";

export const TASK_RESULT_BYTES = 48 * 1024;
export const TASK_DETAILS_BYTES = 120 * 1024;
export const TASK_READ_BYTES = 8 * 1024;
export const TASK_INPUT_BYTES = 24 * 1024;
/** Task title budget, independent of notification wording and rendering. */
export const TASK_TITLE_BYTES = 1024;
export const TASK_LABEL_BYTES = 256;
export const TASK_FACTS = 16;
export const TASK_FACT_BYTES = 1024;
export const TASK_ACTIVITIES = 50;
export const TASK_ERROR_BYTES = 4096;
export const TASK_PATH_BYTES = 8192;

/** A bounded, printable message for any thrown value. */
export function errorText(error: unknown, fallback = "Task execution failed (unprintable error)"): string {
	try {
		return boundText(error instanceof Error ? error.message : String(error), TASK_ERROR_BYTES);
	} catch {
		return fallback;
	}
}

export function boundReadBytes(bytes: number | undefined): number {
	return finiteLimit(bytes, TASK_READ_BYTES, TASK_RESULT_BYTES);
}

/** Both ends are codepoint aligned, including a head read ending inside a character. */
function alignedSlice(buffer: Buffer, start: number, end: number): Buffer {
	while (start < end && (buffer[start]! & 0xc0) === 0x80) start++;
	if (end < buffer.length) {
		while (end > start && (buffer[end]! & 0xc0) === 0x80) end--;
	}
	// A concurrently written file can itself end in an incomplete UTF-8 sequence.
	let lead = end - 1;
	while (lead >= start && (buffer[lead]! & 0xc0) === 0x80) lead--;
	if (lead >= start) {
		const byte = buffer[lead]!;
		const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (end - lead < width) end = lead;
	}
	return buffer.subarray(start, end);
}

export function boundText(text: string, bytes = TASK_RESULT_BYTES): string {
	// Avoid allocating a buffer proportional to an unbounded source.
	const limit = finiteLimit(bytes, TASK_RESULT_BYTES, TASK_RESULT_BYTES);
	const prefix = text.slice(0, limit + 1);
	const buffer = Buffer.from(prefix);
	return alignedSlice(buffer, 0, Math.min(limit, buffer.length)).toString("utf8");
}

export function boundTaskText(text: string, bytes = TASK_RESULT_BYTES): TaskText {
	const bounded = boundText(text, bytes);
	return { text: bounded, truncated: bounded !== text };
}

function activityTime(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundActivity(activity: TaskActivity): TaskActivity {
	const target = activity.target === undefined ? undefined : boundText(activity.target, TASK_FACT_BYTES);
	const error = activity.error === undefined ? undefined : boundText(activity.error, TASK_FACT_BYTES);
	const startedAt = activityTime(activity.startedAt);
	const durationMs = activityTime(activity.durationMs);
	return {
		name: boundText(activity.name, TASK_LABEL_BYTES),
		status: activity.status,
		...(target === undefined ? {} : { target }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(durationMs === undefined ? {} : { durationMs }),
		...(error === undefined ? {} : { error }),
	};
}

/** Keep live display structured data bounded and detached; its plain text remains the portable fallback. */
export function boundTaskDisplay(display: string | TaskDisplay): TaskDisplay {
	if (typeof display === "string") return boundTaskText(display);
	const text = boundTaskText(display.text);
	const activities = display.activities?.slice(-TASK_ACTIVITIES).map(boundActivity);
	const omitted = display.activities ? display.activities.length - (activities?.length ?? 0) : 0;
	const earlierActivities = finiteLimit((display.earlierActivities ?? 0) + omitted, 0, Number.MAX_SAFE_INTEGER);
	return {
		...text,
		truncated: display.truncated || text.truncated,
		...(activities ? { activities } : {}),
		...(display.earlierActivities !== undefined || omitted ? { earlierActivities } : {}),
	};
}

export function boundInput(input: TaskInput): TaskInput {
	const text = boundTaskText(input.text, TASK_INPUT_BYTES);
	return {
		label: boundText(input.label, TASK_LABEL_BYTES),
		text: text.text,
		truncated: input.truncated || text.truncated,
		...(input.language ? { language: boundText(input.language, 64) } : {}),
	};
}

export function boundFacts(facts: readonly TaskFact[]): TaskFact[] {
	return facts
		.slice(0, TASK_FACTS)
		.map(([label, value]): TaskFact => [boundText(label, TASK_LABEL_BYTES), boundText(value, TASK_FACT_BYTES)]);
}

/** The end of a bounded text, codepoint aligned: a command's outcome is at its end. */
export function boundTail(text: string, bytes: number): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return { text, truncated: false };
	return { text: alignedSlice(buffer, buffer.length - bytes, buffer.length).toString("utf8"), truncated: true };
}

/** The bounded model-readable text of a result; images and private details never enter task state. */
export function resultText(result: AgentToolResult<unknown>): TaskText {
	let remaining = TASK_RESULT_BYTES;
	const parts: string[] = [];
	let truncated = false;
	for (const block of result.content) {
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const source = block.type === "text" ? block.text : "[Image omitted from task output]";
		const text = boundText(source, remaining);
		if (block.type !== "text" || text !== source) truncated = true;
		parts.push(text);
		remaining -= Math.max(1, Buffer.byteLength(text) + 1);
	}
	return { text: boundText(parts.join("\n")), truncated };
}

export interface OutputSlice {
	text: string;
	totalBytes: number;
	truncated: boolean;
	fromByte: number;
	/** Raw source-byte end, independent of UTF-8 decoding or replacement characters. */
	endByte: number;
}

/** Raw source-byte range; decoding invalid UTF-8 must never move the continuation offset. */
export function taskReadRange(slice: Pick<TaskRead, "text" | "fromByte" | "endByte">): { from: number; to: number } {
	const from = slice.fromByte ?? 0;
	return { from, to: slice.endByte ?? from + Buffer.byteLength(slice.text) };
}

export function taskReadBytes(slice: Pick<TaskRead, "text" | "fromByte" | "endByte">): number {
	const { from, to } = taskReadRange(slice);
	return to - from;
}

/**
 * The byte window a read covers in an output of `size` bytes. `floor` is the first byte the
 * caller has not seen yet. A head read continues forward from it; a tail read keeps the newest
 * unread window. Anything before the floor never counts as truncated.
 */
function readWindow(size: number, options: TaskReadOptions): { start: number; length: number; floor: number } {
	const bytes = boundReadBytes(options.bytes);
	const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
	const floor = since > size ? 0 : since;
	const start =
		options.mode === "head" ? (options.sinceBytes !== undefined ? floor : 0) : Math.max(floor, size - bytes);
	return { start, length: Math.min(bytes, size - start), floor };
}

function outputSlice(size: number, slice: Buffer, fromByte: number, earlierTruncated: boolean): OutputSlice {
	const endByte = fromByte + slice.byteLength;
	return {
		text: slice.toString("utf8"),
		totalBytes: size,
		truncated: earlierTruncated || endByte < size,
		fromByte,
		endByte,
	};
}

/** Positioned, bounded reads only. The executor owns the path and its cleanup. */
export async function readOutputSlice(path: string, options: TaskReadOptions = {}): Promise<OutputSlice> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const { start, length, floor } = readWindow(size, options);
		// One extra byte lets alignment distinguish a complete last codepoint.
		const buffer = Buffer.alloc(Math.min(length + 1, size - start));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		const slice = alignedSlice(buffer.subarray(0, bytesRead), 0, Math.min(length, bytesRead));
		return outputSlice(
			size,
			slice,
			start + slice.byteOffset - buffer.byteOffset,
			options.mode !== "head" && start > floor,
		);
	} finally {
		await file.close();
	}
}

export function sliceText(text: string, options: TaskReadOptions = {}): OutputSlice {
	const buffer = Buffer.from(text);
	const { start, length, floor } = readWindow(buffer.length, options);
	const slice = alignedSlice(buffer, start, start + length);
	return outputSlice(
		buffer.length,
		slice,
		slice.byteOffset - buffer.byteOffset,
		options.mode !== "head" && start > floor,
	);
}
