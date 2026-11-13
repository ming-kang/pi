import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { formatDuration } from "../../utils/duration.ts";

export const RUN_SUMMARY_ENTRY_TYPE = "run-summary";

export interface RunSummaryRecord {
	version: 1;
	afterEntryId: string;
	startedAt: number;
	finishedAt: number;
	outcome: "done" | "stopped";
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatRunSummary(startedAt: number, finishedAt: number, outcome: "done" | "stopped" = "done"): string {
	const done = new Date(finishedAt);
	const timestamp = `${done.getFullYear()}/${pad(done.getMonth() + 1)}/${pad(done.getDate())} ${pad(done.getHours())}:${pad(done.getMinutes())}`;
	const label = outcome === "done" ? "Done" : "Stopped";
	return `Worked for ${formatDuration(finishedAt - startedAt)} · ${label} ${timestamp}`;
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

/** Persist run boundaries and render each as a dim timing line after its continuous run. */
export default function runSummary(pi: ExtensionAPI): void {
	let startedAt: number | undefined;

	pi.registerEntryRenderer(RUN_SUMMARY_ENTRY_TYPE, (entry, { outputPad }, theme) => {
		const record = readRunSummaryRecord(entry);
		if (!record) return undefined;
		return new Text(
			theme.fg("dim", formatRunSummary(record.startedAt, record.finishedAt, record.outcome)),
			outputPad,
			0,
		);
	});

	pi.on("session_start", () => {
		startedAt = undefined;
	});

	pi.on("before_agent_start", () => {
		// Follow-up work queued into the same continuous run starts another turn before the run
		// settles; the summary still covers the time the user has been waiting since.
		startedAt ??= Date.now();
	});

	pi.on("agent_settled", (event, ctx) => {
		const runStartedAt = startedAt;
		startedAt = undefined;
		if (runStartedAt === undefined || ctx.mode !== "tui") return;
		const afterEntryId = ctx.sessionManager.getLeafId();
		if (!afterEntryId) return;
		pi.appendEntry(RUN_SUMMARY_ENTRY_TYPE, {
			version: 1,
			afterEntryId,
			startedAt: runStartedAt,
			finishedAt: Date.now(),
			outcome: event.aborted ? "stopped" : "done",
		});
	});
}
