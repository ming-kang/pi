import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type CachedCompactionCard, renderCachedCompactionEntry } from "./render.ts";
import { checkpointSummary, keptStart, summaryInstruction } from "./summary.ts";

const CARD_TYPE = "cached-compaction";

export default function cachedCompaction(pi: ExtensionAPI): void {
	/** Card for the summary returned to the current compaction; every compaction starts by clearing it. */
	let pending: { summary: string; card: CachedCompactionCard } | undefined;

	pi.registerEntryRenderer(CARD_TYPE, renderCachedCompactionEntry);

	pi.on("session_before_compact", async (event, ctx) => {
		pending = undefined;
		if (event.reason === "overflow") return;
		const startedAt = Date.now();
		try {
			const snapshot = await ctx.getContextSnapshot();
			const kept = keptStart(event.branchEntries, event.preparation.firstKeptEntryId, snapshot.messages);
			if (!kept) return;
			// A prepared snapshot already carries the leading system message; declaring the prompt and
			// tools again would duplicate it. Before the first request, or after a
			// `context_with_system` handler dropped it, they have to be declared here.
			const declared = snapshot.messages[0]?.role === "system";
			const response = await ctx.modelRuntime
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
						...(declared ? {} : { systemPrompt: snapshot.systemPrompt, tools: snapshot.tools }),
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
			pending = {
				summary: checkpoint.summary,
				card: {
					reason: event.reason,
					cacheRead: response.usage.cacheRead,
					input: response.usage.input,
					cacheWrite: response.usage.cacheWrite,
					output: response.usage.output,
					durationMs: Date.now() - startedAt,
				},
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
		// A later `session_before_compact` handler can override this summary; its card, not ours,
		// describes the compaction that was recorded.
		const card = pending && event.compactionEntry.summary === pending.summary ? pending.card : undefined;
		pending = undefined;
		if (event.fromExtension && card) pi.appendEntry(CARD_TYPE, card);
	});

	pi.on("session_compact_failed", () => {
		pending = undefined;
	});
}
