import { boundWaitMs } from "./limits.ts";

export interface WaitSources {
	/** Any one of these settling ends the wait. */
	settlements: readonly Promise<void>[];
	timeoutMs: number;
	/** Rejects the wait with the signal's reason. */
	signal?: AbortSignal;
	/** Steering: ends the wait without rejecting. */
	interrupt?: AbortSignal;
	/** The runtime closed: ends the wait without rejecting. */
	closed: AbortSignal;
}

/**
 * A race of settlement, timeout, abort, interrupt and close. Whichever ends it first, the timer
 * and every listener are released, so an observation leaves nothing behind. Only an abort rejects.
 */
export function waitForFirst({ settlements, timeoutMs, signal, interrupt, closed }: WaitSources): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Wait aborted"));
	if (interrupt?.aborted || closed.aborted) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const releases: Array<() => void> = [];
		let finished = false;
		const end = (reason?: unknown) => {
			if (finished) return;
			finished = true;
			for (const release of releases) release();
			if (reason === undefined) resolve();
			else reject(reason);
		};
		const on = (source: AbortSignal | undefined, handler: () => void) => {
			if (!source) return;
			source.addEventListener("abort", handler, { once: true });
			releases.push(() => source.removeEventListener("abort", handler));
		};
		on(signal, () => end(signal?.reason ?? new Error("Wait aborted")));
		on(interrupt, () => end());
		on(closed, () => end());
		const timer = setTimeout(() => end(), boundWaitMs(timeoutMs));
		releases.push(() => clearTimeout(timer));
		for (const settlement of settlements) void settlement.then(() => end());
	});
}
