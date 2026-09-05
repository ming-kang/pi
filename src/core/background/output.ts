import { open } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const BACKGROUND_RESULT_BYTES = 48 * 1024;
export const BACKGROUND_DETAILS_BYTES = 120 * 1024;
export const BACKGROUND_READ_BYTES = 8 * 1024;

export function finiteLimit(value: number | undefined, fallback: number, ceiling: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(ceiling, Math.floor(value)));
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

export function boundText(text: string, bytes = BACKGROUND_RESULT_BYTES): string {
	// Avoid allocating a buffer proportional to an unbounded source.
	const limit = finiteLimit(bytes, BACKGROUND_RESULT_BYTES, BACKGROUND_RESULT_BYTES);
	const prefix = text.slice(0, limit + 1);
	const buffer = Buffer.from(prefix);
	return alignedSlice(buffer, 0, Math.min(limit, buffer.length)).toString("utf8");
}

/** Keep valid structured details intact or omit them, never truncate serialized JSON. */
export function boundedResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	let remaining = BACKGROUND_RESULT_BYTES;
	const content: AgentToolResult<unknown>["content"] = [];
	for (const block of result.content) {
		if (remaining <= 0) break;
		const text = boundText(block.type === "text" ? block.text : "[Image omitted from background history]", remaining);
		content.push({ type: "text", text });
		remaining -= Math.max(1, Buffer.byteLength(text));
	}
	let details: unknown;
	try {
		let budget = BACKGROUND_DETAILS_BYTES;
		const json = JSON.stringify(result.details, (key, value: unknown) => {
			// Stop visiting an oversized structure before constructing an unbounded JSON string.
			budget -= Buffer.byteLength(key) + 3;
			budget -= typeof value === "string" ? Buffer.byteLength(value) + 2 : 8;
			if (budget < 0) throw new Error("Background details exceed the storage budget");
			return value;
		});
		if (json !== undefined && Buffer.byteLength(json) <= BACKGROUND_DETAILS_BYTES) details = JSON.parse(json);
	} catch {
		// Runtime handles and cyclic details cannot enter a serializable snapshot.
	}
	return { content, details };
}

export interface OutputSlice {
	text: string;
	totalBytes: number;
	truncated: boolean;
	fromByte: number;
}

/** Positioned, bounded reads only. The executor owns the path and its cleanup. */
export async function readOutputSlice(
	path: string,
	options: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number } = {},
): Promise<OutputSlice> {
	const bytes = finiteLimit(options.bytes, BACKGROUND_READ_BYTES, BACKGROUND_RESULT_BYTES);
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
		const floor = since > size ? 0 : since;
		const start =
			options.sinceBytes !== undefined
				? Math.max(floor, size - bytes)
				: options.mode === "head"
					? 0
					: Math.max(0, size - bytes);
		const length = Math.min(bytes, size - start);
		// One extra byte lets alignment distinguish a complete last codepoint.
		const buffer = Buffer.alloc(Math.min(length + 1, size - start));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
		const slice = alignedSlice(buffer.subarray(0, bytesRead), 0, Math.min(length, bytesRead));
		return {
			text: slice.toString("utf8"),
			totalBytes: size,
			truncated: options.sinceBytes !== undefined ? start > floor || slice.length < length : slice.length < size,
			fromByte: start + slice.byteOffset - buffer.byteOffset,
		};
	} finally {
		await file.close();
	}
}

export function sliceText(
	text: string,
	options: { mode?: "head" | "tail"; bytes?: number; sinceBytes?: number } = {},
): OutputSlice {
	const buffer = Buffer.from(text);
	const bytes = finiteLimit(options.bytes, BACKGROUND_READ_BYTES, BACKGROUND_RESULT_BYTES);
	const since = finiteLimit(options.sinceBytes, 0, Number.MAX_SAFE_INTEGER);
	const floor = since > buffer.length ? 0 : since;
	const start =
		options.sinceBytes !== undefined
			? Math.max(floor, buffer.length - bytes)
			: options.mode === "head"
				? 0
				: Math.max(0, buffer.length - bytes);
	const slice = alignedSlice(buffer, start, Math.min(buffer.length, start + bytes));
	return {
		text: slice.toString("utf8"),
		totalBytes: buffer.length,
		truncated: slice.length < buffer.length - floor,
		fromByte: slice.byteOffset - buffer.byteOffset,
	};
}
