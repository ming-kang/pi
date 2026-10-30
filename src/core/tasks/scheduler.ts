/** Per-key concurrency lanes. Executions without a concurrency key start immediately. */
export interface Schedulable {
	readonly concurrency?: { key: string; limit: number };
	start(): void;
}

interface Lane {
	running: Set<Schedulable>;
	waiting: Schedulable[];
}

export class TaskScheduler {
	private readonly lanes = new Map<string, Lane>();

	schedule(execution: Schedulable): void {
		const concurrency = execution.concurrency;
		if (!concurrency) {
			execution.start();
			return;
		}
		let lane = this.lanes.get(concurrency.key);
		if (!lane) {
			lane = { running: new Set(), waiting: [] };
			this.lanes.set(concurrency.key, lane);
		}
		lane.waiting.push(execution);
		this.pump(concurrency.key, lane);
	}

	/** A settled execution frees its slot or leaves the queue; the next waiting one starts. */
	release(execution: Schedulable): void {
		const key = execution.concurrency?.key;
		const lane = key === undefined ? undefined : this.lanes.get(key);
		if (!lane || key === undefined) return;
		lane.running.delete(execution);
		const index = lane.waiting.indexOf(execution);
		if (index >= 0) lane.waiting.splice(index, 1);
		this.pump(key, lane);
	}

	private pump(key: string, lane: Lane): void {
		// Starting can settle synchronously and re-enter release(); the loop rereads lane state.
		while (lane.waiting.length > 0 && lane.running.size < lane.waiting[0]!.concurrency!.limit) {
			const next = lane.waiting.shift()!;
			lane.running.add(next);
			next.start();
		}
		if (lane.running.size === 0 && lane.waiting.length === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
	}
}
