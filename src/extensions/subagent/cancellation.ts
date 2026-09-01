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
	/** Idempotent: marks the scope aborted and awaits the current handler. */
	abort(): Promise<void>;
	/**
	 * Single-slot abort handler; a later call replaces the earlier one.
	 * Registering after an abort invokes that handler immediately and once by
	 * function identity. The returned unregister function is idempotent.
	 */
	onAbort(handler: () => Promise<void>): () => void;
	throwIfAborted(): void;
	/** Drops the parent-signal listener and the current handler; idempotent. */
	dispose(): void;
}

interface HandlerRegistration {
	id: number;
	handler: () => Promise<void>;
}

export function createRunCancellation(parent: AbortSignal | undefined): RunCancellation {
	const controller = new AbortController();
	const executions = new Map<() => Promise<void>, Promise<void>>();
	let current: HandlerRegistration | undefined;
	let registrationId = 0;
	let disposed = false;

	const executeHandler = (handler: (() => Promise<void>) | undefined): Promise<void> => {
		if (disposed || !handler) return Promise.resolve();
		const existing = executions.get(handler);
		if (existing) return existing;
		const execution = Promise.resolve()
			.then(handler)
			.catch(() => undefined);
		executions.set(handler, execution);
		return execution;
	};

	const trigger = (): Promise<void> => {
		if (disposed) return Promise.resolve();
		if (!controller.signal.aborted) controller.abort();
		return executeHandler(current?.handler);
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
		onAbort(handler: () => Promise<void>): () => void {
			if (disposed) return () => {};
			const registration: HandlerRegistration = { id: ++registrationId, handler };
			current = registration;
			if (controller.signal.aborted) void executeHandler(handler);
			let unregistered = false;
			return () => {
				if (unregistered) return;
				unregistered = true;
				if (current?.id === registration.id) current = undefined;
			};
		},
		throwIfAborted(): void {
			if (controller.signal.aborted) throw new Error("Subagent run was aborted.");
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			current = undefined;
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
