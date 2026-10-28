import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { formatRunSummary } from "./format.ts";
import { RUN_SUMMARY_ENTRY_TYPE, readRunSummaryRecord } from "./record.ts";

function restoreRunSummaries(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	for (const entry of ctx.sessionManager.getBranch()) {
		const record = readRunSummaryRecord(entry);
		if (!record) continue;
		ctx.ui.addTranscriptNote(
			`run-summary:${record.afterEntryId}`,
			formatRunSummary(record.startedAt, record.finishedAt, record.outcome),
			{ afterEntryId: record.afterEntryId },
		);
	}
}

/** Persist run boundaries and project them as timing notes after each continuous run. */
export default function runSummary(pi: ExtensionAPI): void {
	let startedAt: number | undefined;

	pi.on("session_start", (_event, ctx) => {
		startedAt = undefined;
		restoreRunSummaries(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreRunSummaries(ctx);
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

		const finishedAt = Date.now();
		const outcome = event.aborted ? "stopped" : "done";
		ctx.ui.addTranscriptNote(`run-summary:${afterEntryId}`, formatRunSummary(runStartedAt, finishedAt, outcome), {
			afterEntryId,
		});
		pi.appendEntry(RUN_SUMMARY_ENTRY_TYPE, {
			version: 1,
			afterEntryId,
			startedAt: runStartedAt,
			finishedAt,
			outcome,
		});
	});
}
