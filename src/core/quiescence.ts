interface QuiescenceWaiter {
	resolve(): void;
	reject(reason: unknown): void;
}

/**
 * Tracks when a session has nothing left to do. Busy is recorded as soon as a poke observes it;
 * quiet is confirmed one microtask later, after the transition that poked has finished. A
 * transition can look quiet midway, such as a task settlement that journals its record before its
 * completion is enqueued, so reporting quiet early would be wrong where reporting busy early is not.
 */
export class QuiescenceLatch {
	private readonly isBusy: () => boolean;
	private readonly onQuiescent: () => void;
	/** The last confirmed state. Confirming quiet after busy calls `onQuiescent` once. */
	private quiet = true;
	private confirming = false;
	private disposed = false;
	private readonly waiters = new Set<QuiescenceWaiter>();

	constructor(isBusy: () => boolean, onQuiescent: () => void) {
		this.isBusy = isBusy;
		this.onQuiescent = onQuiescent;
	}

	get isQuiescent(): boolean {
		return !this.disposed && !this.isBusy();
	}

	/** Something `isBusy` reads may have changed. */
	poke(): void {
		if (this.disposed) return;
		if (this.isBusy()) {
			this.quiet = false;
			return;
		}
		if (this.quiet || this.confirming) return;
		this.confirming = true;
		queueMicrotask(() => this.confirm());
	}

	private confirm(): void {
		this.confirming = false;
		if (this.disposed || this.isBusy()) return;
		this.quiet = true;
		this.onQuiescent();
		// A listener may have started new work.
		if (!this.quiet) return;
		for (const waiter of [...this.waiters]) waiter.resolve();
	}

	/** Resolve once quiet is confirmed; reject when `signal` aborts or the latch is disposed. */
	wait(signal?: AbortSignal): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("The session was disposed"));
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (!this.isBusy()) return Promise.resolve();
		// Busy now: the next quiet poke must confirm, even if no poke has observed this busy period yet.
		this.quiet = false;
		return new Promise<void>((resolve, reject) => {
			const waiter: QuiescenceWaiter = {
				resolve: () => {
					cleanup();
					resolve();
				},
				reject: (reason) => {
					cleanup();
					reject(reason);
				},
			};
			const onAbort = () => waiter.reject(signal?.reason);
			const cleanup = () => {
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	dispose(): void {
		this.disposed = true;
		for (const waiter of [...this.waiters]) waiter.reject(new Error("The session was disposed"));
	}
}
