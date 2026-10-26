import { Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../core/extensions/types.ts";

export interface CachedCompactionCard {
	reason: "manual" | "threshold";
	cacheRead: number;
	input: number;
	cacheWrite: number;
	output: number;
	durationMs: number;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

export const renderCachedCompactionEntry: EntryRenderer<CachedCompactionCard> = (entry, _options, theme) => {
	const data = entry.data;
	if (!data) return undefined;
	const promptTokens = data.input + data.cacheRead + data.cacheWrite;
	const percentage = promptTokens > 0 ? ((100 * data.cacheRead) / promptTokens).toFixed(1) : "0.0";
	const title = `Cached compaction · ${data.reason === "manual" ? "manual" : "automatic"}`;
	const stats = `Cache ${formatTokens(data.cacheRead)}/${formatTokens(promptTokens)} (${percentage}%) · output ${formatTokens(data.output)} · ${(data.durationMs / 1000).toFixed(1)}s`;
	return new Text(`${theme.fg("accent", title)}\n${theme.fg("dim", stats)}`, 1, 0);
};
