/** JSON POST plumbing for search providers. */

import { readResponseTextBounded } from "../../../utils/http-response.ts";

/** Successful response bodies are model-facing; keep them bounded. */
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;

/** Error bodies are surfaced to the model; keep them bounded. */
const MAX_ERROR_BODY_BYTES = 200;

/** POST a JSON body and return the parsed response. */
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
			errorText = await readResponseTextBounded(response, {
				maxBytes: MAX_ERROR_BODY_BYTES,
				signal: requestSignal,
			});
		} catch {
			requestSignal.throwIfAborted();
		}
		throw new Error(`${errorLabel} returned HTTP ${response.status} ${response.statusText}: ${errorText}`);
	}

	const responseText = await readResponseTextBounded(response, {
		maxBytes: MAX_RESPONSE_BODY_BYTES,
		overflowMessage: `${errorLabel} response exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`,
		signal: requestSignal,
	});
	try {
		return JSON.parse(responseText) as T;
	} catch {
		throw new Error(`${errorLabel} returned invalid JSON`);
	}
}
