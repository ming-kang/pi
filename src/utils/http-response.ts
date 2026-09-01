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

/** Read a response body by bytes, cancelling the stream at the configured boundary. */
export async function readResponseTextBounded(
	response: Response,
	options: BoundedResponseReadOptions,
): Promise<string> {
	if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
		throw new RangeError("maxBytes must be a finite non-negative number");
	}
	const maxBytes = Math.floor(options.maxBytes);
	options.signal?.throwIfAborted();
	if (!response.body) {
		const text = await raceWithAbortSignal(response.text(), options.signal);
		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength <= maxBytes) return text;
		if (options.overflowMessage) throw new Error(options.overflowMessage);
		return new TextDecoder().decode(bytes.subarray(0, maxBytes));
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = "";

	try {
		while (true) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
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
				text += decoder.decode(value.subarray(0, remaining), { stream: true });
				return text + decoder.decode();
			}

			bytesRead += value.byteLength;
			text += decoder.decode(value, { stream: true });
			if (!options.overflowMessage && bytesRead === maxBytes) {
				await cancelReader(reader);
				return text + decoder.decode();
			}
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
