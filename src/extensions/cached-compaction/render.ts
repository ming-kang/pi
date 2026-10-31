import { Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../core/extensions/types.ts";
import { cacheHitPercent } from "../../core/usage-totals.ts";
import { formatTokens } from "../../modes/interactive/components/footer.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDuration } from "../../utils/duration.ts";

export interface CachedCompactionCard {
	reason: "manual" | "threshold";
	cacheRead: number;
	input: number;
	cacheWrite: number;
	output: number;
	durationMs: number;
}

/** Cache reuse is why this path exists, so its rate is the one colored segment. */
function hitRate(card: CachedCompactionCard, theme: Theme): string | undefined {
	const percent = cacheHitPercent(card);
	if (percent === undefined) return undefined;
	return theme.fg(percent >= 80 ? "success" : percent < 50 ? "warning" : "dim", `CH ${percent.toFixed(1)}%`);
}

/** The prompt split by how the provider billed it; parts it did not use are left out. */
function promptBreakdown(card: CachedCompactionCard): string | undefined {
	const total = card.input + card.cacheRead + card.cacheWrite;
	if (total === 0) return undefined;
	const parts = [
		card.cacheRead > 0 ? `R${formatTokens(card.cacheRead)} cached` : undefined,
		card.cacheWrite > 0 ? `W${formatTokens(card.cacheWrite)} written` : undefined,
		card.input > 0 ? `↑${formatTokens(card.input)} uncached` : undefined,
	];
	return `Prompt ${formatTokens(total)} = ${parts.filter(Boolean).join(" + ")}`;
}

/** A footnote to the native compaction summary above it, expanding with it. */
export const renderCachedCompactionEntry: EntryRenderer<CachedCompactionCard> = (entry, { expanded }, theme) => {
	const card = entry.data;
	if (!card) return undefined;
	const dim = (text: string) => theme.fg("dim", text);
	const reason = card.reason === "manual" ? "manual" : "auto";
	const head = [
		dim("From cache"),
		expanded || reason === "auto" ? dim(reason) : undefined,
		hitRate(card, theme),
		expanded ? undefined : dim(`↓${formatTokens(card.output)}`),
		dim(formatDuration(card.durationMs)),
	];
	const lines = [head.filter(Boolean).join(dim(" · "))];
	if (expanded) {
		const breakdown = promptBreakdown(card);
		if (breakdown) lines.push(dim(breakdown));
		lines.push(dim(`Output ↓${formatTokens(card.output)}`));
	}
	return new Text(lines.join("\n"), 1, 0);
};
