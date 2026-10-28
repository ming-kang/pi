import type { SessionEntry } from "../../core/session-manager.ts";

export const RUN_SUMMARY_ENTRY_TYPE = "run-summary";

export interface RunSummaryRecord {
	version: 1;
	afterEntryId: string;
	startedAt: number;
	finishedAt: number;
	outcome: "done" | "stopped";
}

export function readRunSummaryRecord(entry: SessionEntry): RunSummaryRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== RUN_SUMMARY_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.afterEntryId !== "string" ||
		record.afterEntryId.length === 0 ||
		typeof record.startedAt !== "number" ||
		!Number.isFinite(record.startedAt) ||
		record.startedAt < 0 ||
		typeof record.finishedAt !== "number" ||
		!Number.isFinite(record.finishedAt) ||
		record.finishedAt < record.startedAt ||
		(record.outcome !== "done" && record.outcome !== "stopped")
	) {
		return undefined;
	}
	return {
		version: 1,
		afterEntryId: record.afterEntryId,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		outcome: record.outcome,
	};
}
