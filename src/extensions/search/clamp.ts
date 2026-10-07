/** Numeric bounds shared by the tool schemas and the backend limits. */

function coerceInt(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : undefined;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Coerce `value` to an integer inside `[min, max]`, falling back to `def` when it is not numeric.
 * `0` is a real value in every call site (a depth of 0 means "pick one"), so only a non-number
 * takes the default.
 */
export function clampInt(value: unknown, def: number, min: number, max: number): number {
	const n = coerceInt(value);
	if (n === undefined) return def;
	return Math.min(max, Math.max(min, n));
}
