/** Pure compaction policy, shared by settings readers and execution. */
export interface CompactionSettings {
	enabled: boolean;
	keepRecentTokens: number;
	/** Trigger line as a percentage of the context window. Default: 85 */
	triggerPercent?: number;
}

export const DEFAULT_TRIGGER_PERCENT = 85;
export const MIN_TRIGGER_PERCENT = 20;
export const MAX_TRIGGER_PERCENT = 95;

/** Upper bound for the internal summary reserve; not a user setting. */
export const SUMMARY_RESERVE_TOKENS = 16384;

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	keepRecentTokens: 20000,
	triggerPercent: DEFAULT_TRIGGER_PERCENT,
};

export function clampTriggerPercent(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TRIGGER_PERCENT;
	return Math.min(MAX_TRIGGER_PERCENT, Math.max(MIN_TRIGGER_PERCENT, value));
}

/** Context size at which auto-compaction triggers for this window. */
export function triggerTokens(contextWindow: number, settings: CompactionSettings): number {
	return (contextWindow * clampTriggerPercent(settings.triggerPercent ?? DEFAULT_TRIGGER_PERCENT)) / 100;
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	return settings.enabled && contextTokens > triggerTokens(contextWindow, settings);
}

/**
 * Leave room below the trigger for summaries and the next response. Recent
 * messages target at most half the trigger; the summary reserve uses at most
 * a quarter. A split turn can use 0.8 + 0.5 of that reserve across two summaries.
 * Cut points still preserve whole messages and tool-call/result groups, so the
 * retained tail can exceed its target when a single group is too large.
 */
export function getCompactionBudget(
	settings: CompactionSettings,
	contextWindow?: number,
): { keepRecentTokens: number; summaryReserveTokens: number } {
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return { keepRecentTokens: settings.keepRecentTokens, summaryReserveTokens: SUMMARY_RESERVE_TOKENS };
	}
	const threshold = triggerTokens(contextWindow, settings);
	return {
		keepRecentTokens: Math.min(settings.keepRecentTokens, Math.max(1, Math.floor(threshold / 2))),
		// At least two reserve tokens keep both summary output limits positive.
		summaryReserveTokens: Math.min(SUMMARY_RESERVE_TOKENS, Math.max(2, Math.floor(threshold / 4))),
	};
}
