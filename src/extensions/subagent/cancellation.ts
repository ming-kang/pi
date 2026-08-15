/**
 * Per-run cancellation scope.
 *
 * One scope owns a single subagent run for its whole life: queued at the
 * gate, task-retry backoff, worker initialization, and the worker session
 * itself. The derived signal fires on either the parent turn signal or an
 * explicit abort (session shutdown); a single optional handler (the worker
 * session's abort) rides along so aborting also stops the live session.
 */
export interface RunCancellation {
	/** Fires when the parent signal aborts or abort() is called. */
	readonly signal: AbortSignal;
	readonly aborted: boolean;
	/** Idempotent: marks the scope aborted and awaits the registered handler. */
	abort(): Promise<void>;
	/**
	 * Single-slot abort handler; a later call replaces the earlier one.
	 * Registering after an abort invokes the handler immediately. Returns an
	 * unregister function that restores a no-op (the scope stays abortable).
	 */
	onAbort(handler: () => Promise<void>): () => void;
	throwIfAborted(): void;
	/** Drops the parent-signal listener and the handler; idempotent. */
	dispose(): void;
}

const NO_OP_HANDLER = (): Promise<void> => Promise.resolve();

export function createRunCancellation(parent: AbortSignal | undefined): RunCancellation {
	const controller = new AbortController();
	let handler: () => Promise<void> = NO_OP_HANDLER;
	let inFlight: Promise<void> | undefined;
	let disposed = false;

	const trigger = (): Promise<void> => {
		if (disposed) return Promise.resolve();
		if (!controller.signal.aborted) controller.abort();
		inFlight ??= Promise.resolve()
			.then(handler)
			.catch(() => undefined);
		return inFlight;
	};

	const parentListener = (): void => {
		void trigger();
	};
	if (parent) {
		if (parent.aborted) void trigger();
		else parent.addEventListener("abort", parentListener, { once: true });
	}

	return {
		signal: controller.signal,
		get aborted(): boolean {
			return controller.signal.aborted;
		},
		abort: trigger,
		onAbort(next: () => Promise<void>): () => void {
			handler = next;
			if (controller.signal.aborted) void trigger();
			return () => {
				if (handler === next) handler = NO_OP_HANDLER;
			};
		},
		throwIfAborted(): void {
			if (controller.signal.aborted) throw new Error("Subagent run was aborted.");
		},
		dispose(): void {
			disposed = true;
			handler = NO_OP_HANDLER;
			parent?.removeEventListener("abort", parentListener);
		},
	};
}

/** Sleeps until the deadline or the scope aborts; rejects on abort. */
export function abortableSleep(ms: number, scope: RunCancellation): Promise<void> {
	return new Promise((resolve, reject) => {
		if (scope.signal.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			if (timer) clearTimeout(timer);
			scope.signal.removeEventListener("abort", onAbort);
			reject(new Error("Aborted"));
		};
		timer = setTimeout(() => {
			scope.signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		scope.signal.addEventListener("abort", onAbort, { once: true });
	});
}
