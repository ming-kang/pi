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
	mtimeMs?: number;
	filtered?: boolean;
	totalMatches?: number;
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
 * unread window up to `ceiling`. Anything before the floor never counts as truncated.
 */
function readWindow(
	size: number,
	options: TaskReadOptions,
): { start: number; length: number; floor: number; ceiling: number } {
	const bytes = boundReadBytes(options.bytes);
	const ceiling =
		options.endByte !== undefined && Number.isFinite(options.endByte)
			? Math.max(0, Math.min(size, Math.floor(options.endByte)))
			: size;
	const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
	const floor = since > ceiling ? 0 : since;
	const start =
		options.mode === "head" ? (options.sinceBytes !== undefined ? floor : 0) : Math.max(floor, ceiling - bytes);
	return { start, length: Math.min(bytes, ceiling - start), floor, ceiling };
}

function outputSlice(
	size: number,
	slice: Buffer,
	fromByte: number,
	earlierTruncated: boolean,
	mtimeMs?: number,
): OutputSlice {
	const endByte = fromByte + slice.byteLength;
	return {
		text: slice.toString("utf8"),
		totalBytes: size,
		truncated: earlierTruncated || endByte < size,
		fromByte,
		endByte,
		...(mtimeMs !== undefined ? { mtimeMs } : {}),
	};
}

const FILTER_MAX_CHARS = 256;
const FILTER_CHUNK_BYTES = 64 * 1024;
const FILTER_MAX_SCAN_BYTES = 20 * 1024 * 1024;
const FILTER_MAX_CONTEXT = 5;

function buildLineMatcher(rawFilter: string): (line: string) => boolean {
	const filter = rawFilter.slice(0, FILTER_MAX_CHARS);
	const regexMatch = /^\/(.+)\/([imsu]*)$/.exec(filter);
	if (regexMatch) {
		try {
			const regex = new RegExp(regexMatch[1]!, regexMatch[2]!.replace(/g/g, ""));
			return (line) => regex.test(line);
		} catch {
			// Fall back to plain substring matching when regex syntax is invalid.
		}
	}
	const needle = filter.toLowerCase();
	return (line) => line.toLowerCase().includes(needle);
}

function createFilterCollector(filter: string, maxBytes: number, mode: "head" | "tail", contextLines: number) {
	const matches = buildLineMatcher(filter);
	const ctx = finiteLimit(contextLines, 0, FILTER_MAX_CONTEXT);
	const ring: Array<{ lineNo: number; text: string }> = [];
	const rows: string[] = [];
	let rowsBytes = 0;
	let totalMatches = 0;
	let truncated = false;
	let lastEmittedLine = 0;
	let trailingContext = 0;
	let lineNo = 0;
	let headFull = false;

	const pushRow = (row: string) => {
		const rowBytes = Buffer.byteLength(row) + (rows.length > 0 ? 1 : 0);
		if (mode === "head") {
			if (rowsBytes + rowBytes > maxBytes) {
				if (rows.length === 0 && maxBytes > 0) {
					const clipped = boundText(row, maxBytes);
					rows.push(clipped);
					rowsBytes = Buffer.byteLength(clipped);
				}
				truncated = true;
				headFull = true;
				return;
			}
			rows.push(row);
			rowsBytes += rowBytes;
			return;
		}
		const bounded = rowBytes > maxBytes ? boundText(row, maxBytes) : row;
		const boundedBytes = Buffer.byteLength(bounded) + (rows.length > 0 ? 1 : 0);
		if (bounded !== row) truncated = true;
		rows.push(bounded);
		rowsBytes += boundedBytes;
		while (rows.length > 1 && rowsBytes > maxBytes) {
			const dropped = rows.shift()!;
			rowsBytes -= Buffer.byteLength(dropped) + 1;
			truncated = true;
		}
	};

	const emitEntry = (num: number, sep: ":" | "-", text: string) => {
		if (num <= lastEmittedLine) return;
		if (lastEmittedLine > 0 && num > lastEmittedLine + 1 && rows.length > 0) pushRow("--");
		if (headFull) return;
		pushRow(`${num}${sep} ${text}`);
		lastEmittedLine = num;
	};

	const feedLine = (rawLine: string) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		lineNo++;
		if (matches(line)) {
			totalMatches++;
			if (!headFull) {
				for (const before of ring) emitEntry(before.lineNo, "-", before.text);
				emitEntry(lineNo, ":", line);
				trailingContext = ctx;
			}
		} else if (trailingContext > 0 && !headFull) {
			emitEntry(lineNo, "-", line);
			trailingContext--;
		}
		if (ctx > 0) {
			ring.push({ lineNo, text: line });
			if (ring.length > ctx) ring.shift();
		}
	};

	return {
		feedLine,
		finish(size: number, floor: number, endByte: number, scanTruncated: boolean, mtimeMs?: number): OutputSlice {
			return {
				text: rows.join("\n"),
				totalBytes: size,
				truncated: truncated || scanTruncated,
				fromByte: floor,
				endByte,
				filtered: true,
				totalMatches,
				...(mtimeMs !== undefined ? { mtimeMs } : {}),
			};
		},
	};
}

/** Positioned, bounded reads only. The executor owns the path and its cleanup. */
export async function readOutputSlice(path: string, options: TaskReadOptions = {}): Promise<OutputSlice> {
	if (options.filter?.trim()) return filterOutputSlice(path, options);
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		const { size, mtimeMs } = stat;
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
			mtimeMs,
		);
	} finally {
		await file.close();
	}
}

async function filterOutputSlice(path: string, options: TaskReadOptions): Promise<OutputSlice> {
	const file = await open(path, "r");
	try {
		const { size, mtimeMs } = await file.stat();
		const bytes = boundReadBytes(options.bytes);
		const mode = options.mode === "head" ? "head" : "tail";
		const ceiling =
			options.endByte !== undefined && Number.isFinite(options.endByte)
				? Math.max(0, Math.min(size, Math.floor(options.endByte)))
				: size;
		const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
		const floor = since > ceiling ? 0 : since;
		let pos = floor;
		let scanTruncated = ceiling < size;
		if (ceiling - pos > FILTER_MAX_SCAN_BYTES) {
			if (mode === "tail") pos = ceiling - FILTER_MAX_SCAN_BYTES;
			scanTruncated = true;
		}
		const scanEnd = Math.min(ceiling, pos + FILTER_MAX_SCAN_BYTES);
		const collector = createFilterCollector(options.filter!.trim(), bytes, mode, options.contextLines ?? 0);
		const decoder = new TextDecoder();
		const chunk = Buffer.alloc(FILTER_CHUNK_BYTES);
		let pending = "";
		while (pos < scanEnd) {
			const toRead = Math.min(chunk.length, scanEnd - pos);
			const { bytesRead } = await file.read(chunk, 0, toRead, pos);
			if (bytesRead <= 0) break;
			pos += bytesRead;
			const decoded = decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
			pending += decoded;
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				collector.feedLine(pending.slice(0, nl));
				pending = pending.slice(nl + 1);
				nl = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending.length > 0) collector.feedLine(pending);
		return collector.finish(size, floor, pos, scanTruncated, mtimeMs);
	} finally {
		await file.close();
	}
}

export function sliceText(text: string, options: TaskReadOptions = {}): OutputSlice {
	if (options.filter?.trim()) return filterText(text, options);
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

function filterText(text: string, options: TaskReadOptions): OutputSlice {
	const buffer = Buffer.from(text);
	const size = buffer.length;
	const bytes = boundReadBytes(options.bytes);
	const mode = options.mode === "head" ? "head" : "tail";
	const ceiling =
		options.endByte !== undefined && Number.isFinite(options.endByte)
			? Math.max(0, Math.min(size, Math.floor(options.endByte)))
			: size;
	const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
	const floor = since > ceiling ? 0 : since;
	const sliced = alignedSlice(buffer, floor, ceiling).toString("utf8");
	const collector = createFilterCollector(options.filter!.trim(), bytes, mode, options.contextLines ?? 0);
	if (sliced.length > 0) {
		const lines = sliced.split("\n");
		if (lines.at(-1) === "") lines.pop();
		for (const line of lines) collector.feedLine(line);
	}
	return collector.finish(size, floor, ceiling, ceiling < size);
}
