export interface FetchRetryOptions {
	timeoutMs: number;
	retries?: number;
	signal?: AbortSignal;
	label?: string;
}

function delay(milliseconds: number, label: string, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const handleAbort = () => {
			cleanup();
			reject(new Error(`${label} request aborted`));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", handleAbort);
		};

		if (signal?.aborted) {
			handleAbort();
			return;
		}
		signal?.addEventListener("abort", handleAbort, { once: true });
	});
}

async function attemptOnce(
	url: string,
	request: RequestInit,
	timeoutMs: number,
	label: string,
	signal: AbortSignal | undefined,
): Promise<{ ok: true; response: Response; text: string } | { ok: false; error: Error }> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort(signal?.reason);
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetch(url, { ...request, signal: controller.signal });
		const text = await response.text();
		return { ok: true, response, text };
	} catch (error) {
		if (timedOut) throw new Error(`${label} request timed out after ${timeoutMs / 1000}s`);
		if (signal?.aborted) throw new Error(`${label} request aborted`);
		return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

/** Fetch with a per-attempt timeout and bounded retries for transient failures. */
export async function fetchWithRetry(
	url: string,
	request: RequestInit,
	options: FetchRetryOptions,
): Promise<{ response: Response; text: string }> {
	const retries = options.retries ?? 2;
	const label = options.label ?? "HTTP";
	let lastError: Error | undefined;

	for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex++) {
		if (attemptIndex > 0) await delay(1000 * attemptIndex, label, options.signal);
		const outcome = await attemptOnce(url, request, options.timeoutMs, label, options.signal);
		if (!outcome.ok) {
			lastError = outcome.error;
			continue;
		}

		const { response, text } = outcome;
		const retryable = response.status >= 500 || response.status === 429;
		if (!response.ok && retryable && attemptIndex < retries) {
			lastError = new Error(`${label} HTTP ${response.status}`);
			continue;
		}
		return { response, text };
	}

	throw lastError ?? new Error(`${label} request failed`);
}
