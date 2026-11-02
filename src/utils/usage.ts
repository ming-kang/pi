import type { Usage } from "@earendil-works/pi-ai/compat";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Share of one request's prompt served from cache, or undefined when it reported no cache activity. */
export function cacheHitPercent({
	input,
	cacheRead,
	cacheWrite,
}: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const promptTokens = input + cacheRead + cacheWrite;
	return (cacheRead > 0 || cacheWrite > 0) && promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
}
