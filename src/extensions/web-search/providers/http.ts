/**
 * http.ts — Shared JSON POST plumbing for search providers: caller signal plus
 * per-request timeout, bounded upstream error bodies, clear parse errors.
 */

/** Successful response bodies are model-facing; keep them bounded. */
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;

/** Error bodies are surfaced to the model; keep them bounded. */
const MAX_ERROR_BODY_BYTES = 200;

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// The fetch body may already have closed while cancellation was requested.
	}
}

/**
 * Read at most maxBytes from a response body. When overflowMessage is given,
 * reading a byte beyond the limit is an error; otherwise the result is a
 * bounded prefix.
 */
async function readResponseText(response: Response, maxBytes: number, overflowMessage?: string): Promise<string> {
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const remaining = maxBytes - bytesRead;
			if (value.byteLength > remaining) {
				if (overflowMessage) {
					await cancelReader(reader);
					throw new Error(overflowMessage);
				}

				text += decoder.decode(value.subarray(0, remaining), { stream: true });
				await cancelReader(reader);
				return text + decoder.decode();
			}

			bytesRead += value.byteLength;
			text += decoder.decode(value, { stream: true });

			if (!overflowMessage && bytesRead === maxBytes) {
				await cancelReader(reader);
				return text + decoder.decode();
			}
		}

		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

/**
 * POST a JSON body and return the parsed response.
 */
export async function postJson<T>(
	url: string,
	headers: Record<string, string>,
	body: unknown,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	errorLabel: string,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: requestSignal,
	});

	if (!response.ok) {
		let errorText = "";
		try {
			errorText = await readResponseText(response, MAX_ERROR_BODY_BYTES);
		} catch {
			requestSignal.throwIfAborted();
		}
		throw new Error(`${errorLabel} returned HTTP ${response.status} ${response.statusText}: ${errorText}`);
	}

	const responseText = await readResponseText(
		response,
		MAX_RESPONSE_BODY_BYTES,
		`${errorLabel} response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
	);
	try {
		return JSON.parse(responseText) as T;
	} catch {
		throw new Error(`${errorLabel} returned invalid JSON`);
	}
}
