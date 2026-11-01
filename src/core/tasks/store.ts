import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readVersionedTask } from "./codec.ts";
import { errorText, resultText } from "./output.ts";
import { EXPIRED_OUTPUT, TaskRecord } from "./record.ts";
import type { TaskSnapshot } from "./types.ts";

const isForeground = (task: TaskSnapshot) => task.mode === "foreground";

export interface RestoreLimits {
	/** Room left in the foreground history. */
	foreground: number;
	/** Room left in the background history. */
	background: number;
	/** Room left overall, which protected runtime records can shrink below both histories. */
	total: number;
}

/**
 * Which saved terminal snapshots to rehydrate, as a pure function of input order and limits:
 * the newest `endedAt` per ID (a later input wins ties), then the newest few of each history
 * within its room, then the total room, dropping the oldest foreground records before any
 * background one because the transcript already shows foreground output. Returned oldest first.
 */
export function selectRestorable(tasks: readonly TaskSnapshot[], limits: RestoreLimits): TaskSnapshot[] {
	const newest = new Map<string, TaskSnapshot>();
	for (const task of tasks) {
		const previous = newest.get(task.id);
		if (previous && previous.endedAt! > task.endedAt!) continue;
		// Re-inserting keeps arrival order meaningful for ties: the later input is the newer one.
		newest.delete(task.id);
		newest.set(task.id, task);
	}
	// A stable sort keeps arrival order among equal times, so the oldest is the first of its ties.
	const oldestFirst = [...newest.values()].sort((left, right) => left.endedAt! - right.endedAt!);
	const newestOf = (group: TaskSnapshot[], room: number) => group.slice(Math.max(0, group.length - room));
	const keep = new Set([
		...newestOf(oldestFirst.filter(isForeground), limits.foreground),
		...newestOf(
			oldestFirst.filter((task) => !isForeground(task)),
			limits.background,
		),
	]);
	const kept = oldestFirst.filter((task) => keep.has(task));
	const dropped = Math.max(0, kept.length - limits.total);
	if (dropped === 0) return kept;
	const doomed = new Set(
		[...kept.filter(isForeground), ...kept.filter((task) => !isForeground(task))].slice(0, dropped),
	);
	return kept.filter((task) => !doomed.has(task));
}

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
		const saved: TaskSnapshot[] = [];
		for (const value of records) {
			const task = readVersionedTask(value);
			if (!task) continue;
			const existing = this.records.get(task.id);
			if (existing) {
				if (existing.settled) existing.setVisible(true);
				continue;
			}
			saved.push(task);
		}
		const selected = selectRestorable(saved, {
			foreground: foregroundCapacity,
			background: backgroundCapacity,
			total: capacity,
		});
		for (const task of selected) {
			const content = toolResults.get(task.toolCallId);
			if (!task.result && content) task.result = resultText({ content, details: undefined });
			// Logs never outlive the runtime that wrote them.
			const expired = task.outputPath !== undefined;
			task.outputPath = undefined;
			this.add(TaskRecord.restored(task, expired ? EXPIRED_OUTPUT : undefined));
		}
	}

	private cleanupOutput(record: TaskRecord): void {
		const cleanup = record.expireOutput();
		if (!cleanup) return;
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

	/** Settled, unpinned records: the bounded history. Pins (reads, the panel, undelivered completions) have their own allowance. */
	private historyRecords(): TaskRecord[] {
		return this.all().filter((record) => record.inHistory);
	}

	trim(): void {
		if (this.closed) {
			for (const record of this.records.values()) this.cleanupOutput(record);
			return;
		}
		// Pinned records, such as undelivered completions, are never evicted. Admission bounds all retention.
		const history = this.historyRecords();
		// History can be restored from branch snapshots; hidden rows must not occupy the
		// current branch's history budget. Pinned results stay owned.
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
