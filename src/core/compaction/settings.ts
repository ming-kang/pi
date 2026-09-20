/**
 * Percentage trigger line, expressed in upstream's reserve-token budget.
 *
 * Compaction itself only knows `reserveTokens`: it triggers once the context
 * exceeds `contextWindow - reserveTokens`. A fixed reserve behaves very
 * differently across model windows — 16384 tokens is 8% of a 200k window but
 * 1.6% of a million-token one — so this distribution configures the trigger as
 * a percentage of the window and converts it to a reserve for the model in use.
 * An explicit `compaction.reserveTokens` setting still wins.
 */

import type { CompactionSettings } from "./compaction.ts";

export const DEFAULT_TRIGGER_PERCENT = 85;
export const MIN_TRIGGER_PERCENT = 20;
export const MAX_TRIGGER_PERCENT = 95;

export function clampTriggerPercent(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TRIGGER_PERCENT;
	return Math.min(MAX_TRIGGER_PERCENT, Math.max(MIN_TRIGGER_PERCENT, value));
}

/**
 * Reserve and retention for a trigger line at `triggerPercent` of the window.
 *
 * The retained tail stays at or below half the trigger line: keeping more than
 * that would leave the compacted context close to the line again, so the next
 * turn would immediately compact a second time.
 */
export function triggerPercentBudget(
	contextWindow: number,
	triggerPercent: number,
	keepRecentTokens: number,
): Pick<CompactionSettings, "reserveTokens" | "keepRecentTokens"> {
	const triggerTokens = (contextWindow * clampTriggerPercent(triggerPercent)) / 100;
	return {
		reserveTokens: Math.max(1, Math.round(contextWindow - triggerTokens)),
		keepRecentTokens: Math.min(keepRecentTokens, Math.max(1, Math.floor(triggerTokens / 2))),
	};
}
