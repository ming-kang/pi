/**
 * background — bounded reads of a task's output file.
 *
 * Output files grow without limit, so nothing here ever reads a whole file:
 * every read is a positioned slice, aligned so it starts on a UTF-8 codepoint
 * boundary. Split out from registry.ts because process lifecycle and file
 * access are independent concerns — and because the tests already treat them
 * that way.
 */

import { closeSync, openSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

export interface OutputSlice {
	text: string;
	sliceBytes: number;
	totalBytes: number;
	/** True when the file holds more bytes than the slice. */
	truncated: boolean;
	/** True in tail mode when the slice starts mid-line. */
	startsMidLine: boolean;
}

/**
 * Read `length` bytes at `start`, first nudging the start past any UTF-8
 * continuation bytes so the text begins on a codepoint boundary. The same probe
 * reveals whether the slice starts mid-line. A `start` of 0 is used as-is —
 * there is nothing before it to align against.
 */
async function readAligned(
	file: FileHandle,
	size: number,
	start: number,
	length: number,
): Promise<{ text: string; sliceBytes: number; startsMidLine: boolean; position: number }> {
	let position = start;
	let remaining = length;
	let startsMidLine = false;
	if (position > 0 && remaining > 0) {
		// Probe from one byte before the slice: probe[0] tells whether the slice
		// starts at a line boundary, the rest lets us skip UTF-8 continuation
		// bytes (0b10xxxxxx) so we never split a codepoint.
		const probeStart = position - 1;
		const probe = Buffer.alloc(Math.min(5, size - probeStart));
		await file.read(probe, 0, probe.length, probeStart);
		let skip = 0;
		while (1 + skip < probe.length && ((probe[1 + skip] ?? 0) & 0b1100_0000) === 0b1000_0000) {
			skip++;
		}
		position += skip;
		remaining -= skip;
		startsMidLine = probe[skip] !== 0x0a;
	}
	const buffer = Buffer.alloc(Math.max(0, remaining));
	const bytesRead = buffer.length > 0 ? (await file.read(buffer, 0, buffer.length, position)).bytesRead : 0;
	return { text: buffer.subarray(0, bytesRead).toString("utf8"), sliceBytes: bytesRead, startsMidLine, position };
}

/**
 * Read a bounded slice from the head or tail of a file via positioned reads —
 * never the whole file.
 */
export async function readOutputSlice(
	filePath: string,
	options: { mode: "head" | "tail"; maxBytes: number },
): Promise<OutputSlice> {
	const file = await open(filePath, "r");
	try {
		const { size } = await file.stat();
		const length = Math.min(size, Math.max(0, Math.floor(options.maxBytes)));
		const start = options.mode === "tail" ? size - length : 0;
		const slice = await readAligned(file, size, start, length);
		return {
			text: slice.text,
			sliceBytes: slice.sliceBytes,
			totalBytes: size,
			truncated: size > slice.sliceBytes,
			startsMidLine: slice.startsMidLine,
		};
	} finally {
		await file.close();
	}
}

/**
 * Read the last `maxBytes` of a file starting no earlier than `fromByte` — the
 * bounded delta since an offset, tail-aligned so the outcome (at the end of
 * the output) is always included. The returned `fromByte` is where the slice
 * actually starts.
 *
 * An offset past EOF is not an error — the output may have been truncated at
 * the cap, or the caller may be reusing an id from an earlier read. Such a read
 * falls back to the tail and reports `offsetPastEof` so the caller can say so.
 */
export async function readOutputSince(
	filePath: string,
	fromByte: number,
	maxBytes: number,
): Promise<OutputSlice & { fromByte: number; offsetPastEof: boolean }> {
	const file = await open(filePath, "r");
	try {
		const { size } = await file.stat();
		const offsetPastEof = Math.floor(fromByte) > size;
		const floor = offsetPastEof ? 0 : Math.min(Math.max(0, Math.floor(fromByte)), size);
		const length = Math.min(size - floor, Math.max(0, Math.floor(maxBytes)));
		const start = size - length;
		// Decided before alignment: nudging the start past continuation bytes is
		// not the same as dropping output the caller asked for.
		const truncated = start > floor;
		const slice = await readAligned(file, size, start, length);
		return {
			text: slice.text,
			sliceBytes: slice.sliceBytes,
			totalBytes: size,
			truncated,
			startsMidLine: slice.startsMidLine,
			fromByte: slice.position,
			offsetPastEof,
		};
	} finally {
		await file.close();
	}
}

/** A tail read that reports failure instead of throwing; `slice` is absent when `error` is set. */
export interface TailRead {
	slice?: OutputSlice;
	error?: string;
}

/**
 * Tail read for notifications and the stall probe — the one place that decides
 * what "the output could not be read" looks like, so neither caller has to
 * accumulate the same six fields by hand. Text is returned raw; callers
 * sanitize at the point they render it.
 */
export async function readTail(filePath: string, maxBytes: number): Promise<TailRead> {
	try {
		return { slice: await readOutputSlice(filePath, { mode: "tail", maxBytes }) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Create an empty output file exclusively ('wx'): fails on any existing path,
 * including a symlink, so creation can never truncate what the path points at.
 */
export function createOutputFileExclusively(path: string): void {
	const handle = openSync(path, "wx");
	closeSync(handle);
}
