/** A non-negative integer limit: `fallback` for a missing or non-finite value, otherwise floored and capped at `ceiling`. */
export function finiteLimit(value: number | undefined, fallback: number, ceiling: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(ceiling, Math.floor(value)));
}

/** Format token counts for compact footer and panel display (`123`, `1.2k`, `12k`, `1.2M`, `12M`). */
export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
