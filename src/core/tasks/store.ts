import { parseTaskHistory } from "./history.ts";
import { boundText } from "./output.ts";
import { isInlineLogTask, type TaskSnapshot } from "./types.ts";

export interface TaskRecord {
	task: TaskSnapshot;
	settled: boolean;
	handedOff?: boolean;
	accounted: boolean;
	visible: boolean;
	suppressed: boolean;
	delivery: "pending" | "claimed" | "delivered";
	pins: number;
	deliveryHolds: number;
	cleanup?: () => void | Promise<void>;
	readError?: string;
	waiters: Set<() => void>;
}

function errorText(error: unknown): string {
	try {
		return boundText(error instanceof Error ? error.message : String(error), 4096);
	} catch {
		return "Task cleanup failed";
	}
}

function oldestTask(tasks: Iterable<TaskSnapshot>): TaskSnapshot | undefined {
	let oldest: TaskSnapshot | undefined;
	for (const task of tasks) {
		if (!oldest || task.endedAt! < oldest.endedAt!) oldest = task;
	}
	return oldest;
}

/** Retained snapshots and output leases. This store never owns executable handles. */
export class TaskStore {
	readonly records = new Map<string, TaskRecord>();
	readonly cleanups = new Set<Promise<void>>();
	private readonly maxHistory: number;
	private readonly maxRetained: number;
	private readonly isClosed: () => boolean;
	private readonly onCleanupError?: (message: string) => void;
	constructor(
		maxHistory: number,
		maxRetained: number,
		isClosed: () => boolean,
		onCleanupError?: (message: string) => void,
	) {
		this.maxHistory = maxHistory;
		this.maxRetained = maxRetained;
		this.isClosed = isClosed;
		this.onCleanupError = onCleanupError;
	}
	private get closed(): boolean {
		return this.isClosed();
	}
	restoreHistory(records: readonly unknown[]): void {
		if (this.closed) return;
		// Restoration must not evict runtime-owned records or run their cleanup callbacks.
		const history = this.historyRecords();
		const shells = history.filter((record) => isInlineLogTask(record.task)).length;
		const shellCapacity = Math.max(0, this.maxHistory - shells);
		const taskCapacity = Math.max(0, this.maxHistory - (history.length - shells));
		const capacity = Math.max(
			0,
			Math.min(shellCapacity + taskCapacity, this.maxRetained - this.records.size - this.cleanups.size),
		);
		const newest = new Map<string, TaskSnapshot>();
		for (const value of records) {
			const task = parseTaskHistory(value);
			if (!task) continue;
			const existing = this.records.get(task.id);
			if (existing) {
				if (existing.settled) existing.visible = true;
				continue;
			}
			if (capacity === 0) continue;
			const previous = newest.get(task.id);
			if (previous && previous.endedAt! > task.endedAt!) continue;
			newest.delete(task.id);
			const shell = isInlineLogTask(task);
			const limit = shell ? shellCapacity : taskCapacity;
			if (limit === 0) continue;
			newest.set(task.id, task);
			const group = [...newest.values()].filter((candidate) => isInlineLogTask(candidate) === shell);
			if (group.length > limit) newest.delete(oldestTask(group)!.id);
			if (newest.size > capacity) {
				// Protected runtime records can leave less room than both histories allow.
				// Restore inspectable tasks before hidden foreground shell logs in that case.
				const foreground = [...newest.values()].filter(isInlineLogTask);
				newest.delete(oldestTask(foreground.length ? foreground : newest.values())!.id);
			}
		}
		for (const task of [...newest.values()].sort((a, b) => a.endedAt! - b.endedAt!)) {
			this.records.set(task.id, {
				task,
				settled: true,
				accounted: true,
				visible: true,
				suppressed: true,
				delivery: "delivered",
				pins: 0,
				deliveryHolds: 0,
				waiters: new Set(),
			});
		}
	}

	private cleanupOutput(record: TaskRecord): void {
		if (!record.settled || record.pins || record.waiters.size || !record.cleanup) return;
		const cleanup = record.cleanup;
		record.cleanup = undefined;
		// Snapshots retain final bounded text; expired files are never needed to render history.
		record.task.outputPath = undefined;
		record.readError = "Output has expired: the managed log was released; showing the stored result.";
		const pending = Promise.resolve()
			.then(cleanup)
			.catch((error: unknown) => {
				try {
					this.onCleanupError?.(errorText(error));
				} catch {
					/* Cleanup/reporting is best effort, never an unhandled rejection. */
				}
			})
			.finally(() => this.cleanups.delete(pending));
		this.cleanups.add(pending);
	}

	/** Pending delivery, active reads and pins have their own bounded retention allowance. */
	private historyRecords(): TaskRecord[] {
		return [...this.records.values()].filter(
			(record) => record.settled && record.delivery === "delivered" && !record.pins && !record.waiters.size,
		);
	}

	trim(): void {
		if (this.closed) {
			for (const record of this.records.values()) this.cleanupOutput(record);
			return;
		}
		// Undelivered notifications and claims are never evicted. Admission bounds all retention.
		const history = this.historyRecords();
		// Delivered history can be restored from branch snapshots; hidden rows must
		// not occupy the current branch's history budget. Pending results stay owned.
		const expired = history.filter((record) => !record.visible);
		for (const shell of [false, true]) {
			const group = history.filter((record) => record.visible && isInlineLogTask(record.task) === shell);
			group.sort((left, right) => (left.task.endedAt ?? 0) - (right.task.endedAt ?? 0));
			expired.push(...group.slice(0, Math.max(0, group.length - this.maxHistory)));
		}
		for (const record of expired) {
			this.records.delete(record.task.id);
			this.cleanupOutput(record);
		}
	}
}
