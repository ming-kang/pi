/** Bounded streaming reads shared by extensions that consume HTTP responses. */

import { raceWithAbortSignal } from "./abort.ts";

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// The body may already have closed while cancellation was requested.
	}
}

export interface BoundedResponseReadOptions {
	maxBytes: number;
	/** Throw on overflow; without it, return a bounded prefix. */
	overflowMessage?: string;
	signal?: AbortSignal;
}

/** One bounded stream read, shared by the text and byte readers so both stop at the same boundary. */
interface BoundedRead {
	chunks: Uint8Array[];
	/** The stream was cut at `maxBytes`; a final multi-byte character may be incomplete. */
	truncated: boolean;
}

function checkMaxBytes(maxBytes: number): number {
	if (!Number.isFinite(maxBytes) || maxBytes < 0) {
		throw new RangeError("maxBytes must be a finite non-negative number");
	}
	return Math.floor(maxBytes);
}

/**
 * Read a response body by bytes, cancelling the stream at the configured boundary. `response.text()`
 * and `response.arrayBuffer()` are never awaited, since neither is bounded; a real null body is
 * simply empty, and a body-less implementation is bounded by the length of the text it returns.
 */
async function readBounded(response: Response, options: BoundedResponseReadOptions): Promise<BoundedRead> {
	const maxBytes = checkMaxBytes(options.maxBytes);
	options.signal?.throwIfAborted();
	if (!response.body) {
		const text = await raceWithAbortSignal(response.text(), options.signal);
		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength <= maxBytes) return { chunks: [bytes], truncated: false };
		if (options.overflowMessage) throw new Error(options.overflowMessage);
		return { chunks: [bytes.subarray(0, maxBytes)], truncated: true };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	try {
		while (true) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await raceWithAbortSignal(reader.read(), options.signal);
			} catch (error) {
				if (options.signal?.aborted) await cancelReader(reader);
				throw error;
			}
			const { done, value } = chunk;
			if (done) break;
			if (!value) continue;

			const remaining = maxBytes - bytesRead;
			if (value.byteLength > remaining) {
				await cancelReader(reader);
				if (options.overflowMessage) throw new Error(options.overflowMessage);
				chunks.push(value.subarray(0, remaining));
				return { chunks, truncated: true };
			}

			bytesRead += value.byteLength;
			chunks.push(value);
			if (!options.overflowMessage && bytesRead === maxBytes) {
				await cancelReader(reader);
				return { chunks, truncated: true };
			}
		}
		return { chunks, truncated: false };
	} finally {
		reader.releaseLock();
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Bytes of an incomplete trailing UTF-8 sequence, so a prefix never flushes it as U+FFFD. */
function incompleteTailLength(bytes: Uint8Array): number {
	for (let back = 1; back <= 4 && back <= bytes.length; back++) {
		const byte = bytes[bytes.length - back]!;
		if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep walking back
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return back < length ? back : 0;
	}
	return 0;
}

/** Read a response body by bytes, cancelling the stream at the configured boundary. */
export async function readResponseBytesBounded(
	response: Response,
	options: BoundedResponseReadOptions,
): Promise<Uint8Array> {
	return concat((await readBounded(response, options)).chunks);
}

/** Read a response body as text, bounded by encoded bytes and cut only at character boundaries. */
export async function readResponseTextBounded(
	response: Response,
	options: BoundedResponseReadOptions,
): Promise<string> {
	const { chunks, truncated } = await readBounded(response, options);
	if (chunks.length === 0) return "";
	const bytes = concat(chunks);
	if (truncated) {
		const tail = incompleteTailLength(bytes);
		if (tail) return new TextDecoder().decode(bytes.subarray(0, bytes.length - tail));
	}
	return new TextDecoder().decode(bytes);
}
