import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readVersionedTask } from "./codec.ts";
import { errorText, resultText } from "./output.ts";
import { TaskRecord } from "./record.ts";
import type { TaskSnapshot } from "./types.ts";

export const EXPIRED_OUTPUT = "Output has expired: the managed log was released; showing the stored result.";

function oldestTask(tasks: Iterable<TaskSnapshot>): TaskSnapshot | undefined {
	let oldest: TaskSnapshot | undefined;
	for (const task of tasks) {
		if (!oldest || task.endedAt! < oldest.endedAt!) oldest = task;
	}
	return oldest;
}

const isForeground = (task: TaskSnapshot) => task.mode === "foreground";

/** Retained snapshots and output leases. This store never owns executable handles. */
export class TaskStore {
	private readonly records = new Map<string, TaskRecord>();
	private readonly cleanups = new Set<Promise<void>>();
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

	get(id: string): TaskRecord | undefined {
		return this.records.get(id);
	}

	/** Records whose ID, or whose ID without its kind prefix, starts with `prefix`. */
	match(prefix: string): TaskRecord[] {
		return this.all().filter(
			({ task }) => task.id.startsWith(prefix) || task.id.slice(task.kind.length + 1).startsWith(prefix),
		);
	}

	add(record: TaskRecord): void {
		this.records.set(record.task.id, record);
	}

	all(): TaskRecord[] {
		return [...this.records.values()];
	}

	/** Records whose execution has not settled, queued or running. */
	unsettled(): TaskRecord[] {
		return this.all().filter((record) => !record.settled);
	}

	/** Records on the selected branch. */
	visible(): TaskRecord[] {
		return this.all().filter((record) => record.visible);
	}

	/** Settled handoffs eligible for automatic delivery. */
	deliverable(): TaskRecord[] {
		return this.all().filter((record) => record.deliverable);
	}

	/** Records plus output cleanups still running; admission bounds this. */
	retainedCount(): number {
		return this.records.size + this.cleanups.size;
	}

	/** Settles once every output cleanup started so far has finished. */
	cleanupsDone(): Promise<unknown> {
		return Promise.all(this.cleanups);
	}

	/**
	 * Foreground records save no output of their own: their tool result already holds it,
	 * so `toolResults` maps each tool call ID on the branch to that content.
	 */
	restoreHistory(
		records: readonly unknown[],
		toolResults: ReadonlyMap<string, AgentToolResult<unknown>["content"]> = new Map(),
	): void {
		if (this.closed) return;
		// Restoration must not evict runtime-owned records or run their cleanup callbacks.
		const history = this.historyRecords();
		const foreground = history.filter((record) => isForeground(record.task)).length;
		const foregroundCapacity = Math.max(0, this.maxHistory - foreground);
		const backgroundCapacity = Math.max(0, this.maxHistory - (history.length - foreground));
		const capacity = Math.max(
			0,
			Math.min(foregroundCapacity + backgroundCapacity, this.maxRetained - this.retainedCount()),
		);
		const newest = new Map<string, TaskSnapshot>();
		for (const value of records) {
			const task = readVersionedTask(value);
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
			const inline = isForeground(task);
			const limit = inline ? foregroundCapacity : backgroundCapacity;
			if (limit === 0) continue;
			newest.set(task.id, task);
			const group = [...newest.values()].filter((candidate) => isForeground(candidate) === inline);
			if (group.length > limit) newest.delete(oldestTask(group)!.id);
			if (newest.size > capacity) {
				// Protected runtime records can leave less room than both histories allow.
				// Restore background results before foreground ones, which the transcript shows.
				const inlineTasks = [...newest.values()].filter(isForeground);
				newest.delete(oldestTask(inlineTasks.length ? inlineTasks : newest.values())!.id);
			}
		}
		for (const task of [...newest.values()].sort((a, b) => a.endedAt! - b.endedAt!)) {
			const content = toolResults.get(task.toolCallId);
			if (!task.result && content) task.result = resultText({ content, details: undefined });
			// Logs never outlive the runtime that wrote them.
			const expired = task.outputPath !== undefined;
			task.outputPath = undefined;
			this.add(TaskRecord.restored(task, expired ? EXPIRED_OUTPUT : undefined));
		}
	}

	private cleanupOutput(record: TaskRecord): void {
		if (!record.settled || record.pins || record.waiters.size || !record.cleanup) return;
		const cleanup = record.cleanup;
		record.cleanup = undefined;
		// Snapshots retain final bounded text; expired files are never needed to render history.
		record.update((task) => {
			task.outputPath = undefined;
		});
		record.readError = EXPIRED_OUTPUT;
		const pending = Promise.resolve()
			.then(cleanup)
			.catch((error: unknown) => {
				try {
					this.onCleanupError?.(errorText(error, "Task cleanup failed"));
				} catch {
					/* Cleanup/reporting is best effort, never an unhandled rejection. */
				}
			})
			.finally(() => this.cleanups.delete(pending));
		this.cleanups.add(pending);
	}

	/** Pending delivery, active reads and pins have their own bounded retention allowance. */
	private historyRecords(): TaskRecord[] {
		return this.all().filter((record) => record.inHistory);
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
		for (const inline of [false, true]) {
			const group = history.filter((record) => record.visible && isForeground(record.task) === inline);
			group.sort((left, right) => (left.task.endedAt ?? 0) - (right.task.endedAt ?? 0));
			expired.push(...group.slice(0, Math.max(0, group.length - this.maxHistory)));
		}
		for (const record of expired) {
			this.records.delete(record.task.id);
			this.cleanupOutput(record);
		}
	}
}
