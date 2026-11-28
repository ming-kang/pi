import type { CustomMessage } from "../messages.ts";
import type { SessionEntry } from "../session-manager.ts";
import { readVersionedTask, readVersionedTaskRecord, TASK_COMPLETION_TYPE, TASK_RECORD_TYPE } from "./codec.ts";
import { MAX_DELIVERY_BATCH_BYTES, MAX_DELIVERY_BATCH_MESSAGES, messageContentBytes } from "./delivery.ts";
import { taskCompletionMessage } from "./presentation.ts";
import { sanitizeRestoredOutput } from "./store.ts";
import type { TaskSnapshot } from "./types.ts";

export interface CollectUndeliveredOptions {
	branchEntries: readonly SessionEntry[];
	contextEntries: readonly SessionEntry[];
	trustedArtifactDir: string | undefined;
	excludedIds: ReadonlySet<string>;
	isLiveDelivery(taskId: string): boolean;
}

/**
 * Find settled background tasks in the active (compaction-aware) context that never received a
 * `task-completion` message on the current branch, excluding acknowledged and live-delivery tasks.
 */
export function collectUndeliveredBackgroundTasks(options: CollectUndeliveredOptions): TaskSnapshot[] {
	const excluded = new Set(options.excludedIds);
	for (const entry of options.branchEntries) {
		if (entry.type !== "custom_message" || entry.customType !== TASK_COMPLETION_TYPE) continue;
		const task = readVersionedTask(entry.details);
		if (task) excluded.add(task.id);
	}

	const pending = new Map<string, TaskSnapshot>();
	for (const entry of options.contextEntries) {
		if (entry.type !== "custom" || entry.customType !== TASK_RECORD_TYPE) continue;
		const parsed = readVersionedTaskRecord(entry.data);
		if (!parsed || parsed.task.mode !== "background") continue;
		const { task } = parsed;
		if (excluded.has(task.id) || options.isLiveDelivery(task.id)) continue;
		const previous = pending.get(task.id);
		if (previous && previous.endedAt! > task.endedAt!) continue;
		pending.set(task.id, task);
	}

	return [...pending.values()].map((task) => sanitizeRestoredOutput(task, options.trustedArtifactDir).task);
}

/** Build one passive-reconciliation batch bounded by the same message and byte budgets as live delivery. */
export function buildReconciliationBatch(tasks: readonly TaskSnapshot[]): CustomMessage[] {
	const messages: CustomMessage[] = [];
	let totalBytes = 0;
	for (const task of tasks) {
		if (messages.length >= MAX_DELIVERY_BATCH_MESSAGES) break;
		const message = taskCompletionMessage(task);
		const size = messageContentBytes(message);
		if (messages.length > 0 && totalBytes + size > MAX_DELIVERY_BATCH_BYTES) break;
		messages.push(message);
		totalBytes += size;
	}
	return messages;
}
