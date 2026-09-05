import type { FetchFunction } from "@earendil-works/pi-ai";

function wait(delay: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const finish = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, delay);
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function isNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	if (error instanceof TypeError || error.name === "NetworkError" || error.name === "TimeoutError") return true;
	return (
		"code" in error &&
		typeof error.code === "string" &&
		/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
			error.code,
		)
	);
}

function discard(response: Response): void {
	// Do not await cancellation: a custom stream's cancellation can remain pending forever.
	void response.body?.cancel().catch(() => {});
}

/** Codex 0.153.4 HTTP policy only; pi-ai owns successful Responses bodies and all SSE handling. */
export function createCodexTransport(
	fetch: FetchFunction,
	options: {
		maxRetries?: number;
		maxRetryDelayMs?: number;
		signal?: AbortSignal;
		onErrorResponse?: (response: Response) => void | Promise<void>;
	} = {},
): FetchFunction {
	// codex-client/src/retry.rs and model-provider-info/src/lib.rs: 4 retries, 200ms, 0.9..1.1 jitter.
	const retries = Math.min(
		100,
		Math.max(0, Math.floor(Number.isNaN(options.maxRetries) ? 4 : (options.maxRetries ?? 4))),
	);
	// Node timers overflow above this limit; never turn a large backoff into a tight retry loop.
	const maxDelay = Math.min(
		2_147_483_647,
		Math.max(0, Number.isNaN(options.maxRetryDelayMs) ? 2_147_483_647 : (options.maxRetryDelayMs ?? 2_147_483_647)),
	);
	return async (input, init) => {
		const request = input instanceof Request ? input : undefined;
		const signals = [options.signal, request?.signal, init?.signal].filter(
			(signal): signal is AbortSignal => signal != null,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		const forwarded = signal ? { ...init, signal } : init;
		const body = init?.body ?? request?.body;
		// Never clone/tee or buffer a private prompt. Request bodies and streaming init bodies are single-use.
		const replayable =
			(!request?.bodyUsed || init?.body != null) &&
			(body == null ||
				typeof body === "string" ||
				body instanceof Blob ||
				body instanceof FormData ||
				body instanceof URLSearchParams ||
				body instanceof ArrayBuffer ||
				ArrayBuffer.isView(body));
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			let response: Response;
			try {
				response = await fetch(input, forwarded);
			} catch (error) {
				signal?.throwIfAborted();
				if (!replayable || attempt >= retries || !isNetworkError(error)) throw error;
				await wait(Math.min(maxDelay, Math.floor(200 * 2 ** attempt * (0.9 + Math.random() * 0.2))), signal);
				continue;
			}
			if (response.ok) return response;
			// Deliberately outside the fetch catch: callback failures must never cause another request.
			try {
				await options.onErrorResponse?.(response);
			} catch (error) {
				discard(response);
				throw error;
			}
			if (!replayable || attempt >= retries || response.status < 500 || response.status > 599) return response;
			discard(response);
			await wait(Math.min(maxDelay, Math.floor(200 * 2 ** attempt * (0.9 + Math.random() * 0.2))), signal);
		}
	};
}
