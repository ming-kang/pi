/** A non-negative integer limit: `fallback` for a missing or non-finite value, otherwise floored and capped at `ceiling`. */
export function finiteLimit(value: number | undefined, fallback: number, ceiling: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(ceiling, Math.floor(value)));
}
