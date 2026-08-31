/**
 * http.ts — Shared JSON POST plumbing for search providers: caller signal plus
 * per-request timeout, bounded upstream error bodies, clear parse errors.
 */

/** Error bodies are surfaced to the model; keep them bounded. */
const MAX_ERROR_BODY_LENGTH = 200;

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
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`${errorLabel} returned HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
		);
	}

	return (await response.json().catch(() => {
		throw new Error(`${errorLabel} returned invalid JSON`);
	})) as T;
}
