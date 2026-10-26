import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type CachedCompactionCard, renderCachedCompactionEntry } from "./render.ts";
import { checkpointSummary, keptStart, summaryInstruction } from "./summary.ts";

const CARD_TYPE = "cached-compaction";

export default function cachedCompaction(pi: ExtensionAPI): void {
	let completed: CachedCompactionCard | undefined;
	let pendingCard: CachedCompactionCard | undefined;

	pi.registerEntryRenderer(CARD_TYPE, renderCachedCompactionEntry);

	pi.on("session_before_compact", async (event, ctx) => {
		completed = undefined;
		if (event.reason === "overflow") return;
		const startedAt = Date.now();
		try {
			const snapshot = await ctx.getContextSnapshot();
			const kept = keptStart(event.branchEntries, event.preparation.firstKeptEntryId, snapshot.messages);
			if (!kept) return;
			const response = await ctx.modelRegistry
				.streamSimple(
					snapshot.model,
					{
						messages: [
							...snapshot.messages,
							{
								role: "user",
								content: [{ type: "text", text: summaryInstruction(kept, event.customInstructions) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						...snapshot.streamOptions,
						reasoning: snapshot.thinkingLevel === "off" ? undefined : snapshot.thinkingLevel,
						signal: event.signal,
					},
				)
				.result();
			if (response.stopReason === "aborted") return { cancel: true };
			if (response.stopReason !== "stop" || response.content.some((block) => block.type === "toolCall")) return;
			const text = contentText(response.content).trim();
			if (!text) return;
			const checkpoint = checkpointSummary(text, event.preparation.fileOps, event.branchEntries);
			completed = {
				reason: event.reason,
				cacheRead: response.usage.cacheRead,
				input: response.usage.input,
				cacheWrite: response.usage.cacheWrite,
				output: response.usage.output,
				durationMs: Date.now() - startedAt,
			};
			return {
				compaction: {
					summary: checkpoint.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: response.usage,
					details: checkpoint.details,
				},
			};
		} catch {
			return event.signal.aborted ? { cancel: true } : undefined;
		}
	});

	pi.on("session_compact", (event) => {
		if (!event.fromExtension || !completed) return;
		const card = completed;
		completed = undefined;
		pendingCard = card;
		setTimeout(() => {
			if (pendingCard !== card) return;
			pendingCard = undefined;
			try {
				pi.appendEntry(CARD_TYPE, card);
			} catch {
				// The session may be disposed before the deferred card is appended.
			}
		}, 0);
	});

	pi.on("session_compact_failed", () => {
		completed = undefined;
	});
	pi.on("session_shutdown", () => {
		completed = undefined;
		pendingCard = undefined;
	});
}
