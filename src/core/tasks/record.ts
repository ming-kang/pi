import type { TaskSnapshot } from "./types.ts";

/**
 * none: running, or answered inline by its tool call; pending: a settled handoff
 * awaiting automatic delivery; claimed: handed to the host; delivered: acknowledged.
 */
export type TaskDeliveryState = "none" | "pending" | "claimed" | "delivered";

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/**
 * The runtime's state for one task: its working snapshot, retention counters and delivery
 * state. The working snapshot changes only through `update()`, which also drops the frozen
 * copy that readers share, so a mutation can never leave a stale snapshot behind.
 */
export class TaskRecord {
	/** Read-only view of the working copy; change it with update(). */
	readonly task: Readonly<TaskSnapshot>;
	settled = false;
	/** Whether the launch anchor is on the selected branch. */
	visible = true;
	pins = 0;
	deliveryHolds = 0;
	cleanup?: () => void | Promise<void>;
	readError?: string;
	readonly waiters = new Set<() => void>();
	private readonly working: TaskSnapshot;
	private frozen?: TaskSnapshot;
	private state: TaskDeliveryState = "none";

	constructor(task: TaskSnapshot) {
		this.working = task;
		this.task = task;
	}

	/** A terminal record rebuilt from persisted history: nothing is left to run or deliver. */
	static restored(task: TaskSnapshot, readError: string | undefined): TaskRecord {
		const record = new TaskRecord(task);
		record.settled = true;
		record.state = "delivered";
		record.readError = readError;
		return record;
	}

	update(mutate: (task: TaskSnapshot) => void): void {
		try {
			mutate(this.working);
		} finally {
			this.frozen = undefined;
		}
	}

	/** Readers share one frozen copy, so polling and status rendering never clone unchanged output. */
	snapshot(): TaskSnapshot {
		this.frozen ??= freeze(structuredClone(this.working));
		return this.frozen;
	}

	get delivery(): TaskDeliveryState {
		return this.state;
	}

	/** A settled handoff the host has not yet been told about. */
	queueDelivery(): void {
		this.state = "pending";
	}

	/** The result was answered inline, or the host acknowledged its delivery. */
	acknowledge(): void {
		this.state = "delivered";
	}

	/** Only explicit result-delivery holds and active waits delay an automatic completion. */
	get deliverable(): boolean {
		return this.visible && this.state === "pending" && this.waiters.size === 0 && this.deliveryHolds === 0;
	}

	claim(): boolean {
		if (!this.deliverable) return false;
		this.state = "claimed";
		return true;
	}

	/** Return a claimed record to pending after a failed delivery. */
	unclaim(): boolean {
		if (this.state !== "claimed") return false;
		this.state = "pending";
		return true;
	}

	/** Delivered, unpinned and unwatched: bounded history that retention may evict. */
	get inHistory(): boolean {
		return this.settled && this.state === "delivered" && !this.pins && !this.waiters.size;
	}
}
