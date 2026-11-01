/** Per-executor concurrency lanes. Executions without a concurrency key start immediately. */
export interface Schedulable {
	/** The executor kind, which namespaces its lane keys. */
	readonly kind: string;
	readonly concurrency?: { key: string; limit: number };
	start(): void;
}

interface Lane {
	running: Set<Schedulable>;
	waiting: Schedulable[];
}

/** A lane belongs to one executor kind, so two executors can never collide on a chosen key. */
function laneId(execution: Schedulable): string | undefined {
	return execution.concurrency ? `${execution.kind}:${execution.concurrency.key}` : undefined;
}

export class TaskScheduler {
	private readonly lanes = new Map<string, Lane>();

	schedule(execution: Schedulable): void {
		const id = laneId(execution);
		if (id === undefined) {
			execution.start();
			return;
		}
		let lane = this.lanes.get(id);
		if (!lane) {
			lane = { running: new Set(), waiting: [] };
			this.lanes.set(id, lane);
		}
		lane.waiting.push(execution);
		this.pump(id, lane);
	}

	/** A settled execution frees its slot or leaves the queue; the next waiting one starts. */
	release(execution: Schedulable): void {
		const id = laneId(execution);
		const lane = id === undefined ? undefined : this.lanes.get(id);
		if (!lane || id === undefined) return;
		lane.running.delete(execution);
		const index = lane.waiting.indexOf(execution);
		if (index >= 0) lane.waiting.splice(index, 1);
		this.pump(id, lane);
	}

	private pump(id: string, lane: Lane): void {
		// Starting can settle synchronously and re-enter release(); the loop rereads lane state.
		while (lane.waiting.length > 0 && lane.running.size < lane.waiting[0]!.concurrency!.limit) {
			const next = lane.waiting.shift()!;
			lane.running.add(next);
			next.start();
		}
		if (lane.running.size === 0 && lane.waiting.length === 0 && this.lanes.get(id) === lane) this.lanes.delete(id);
	}
}
