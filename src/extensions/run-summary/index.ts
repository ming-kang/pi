import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { formatRunSummary } from "./format.ts";
import { RUN_SUMMARY_ENTRY_TYPE, readRunSummaryRecord } from "./record.ts";

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
		startedAt = Date.now();
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
