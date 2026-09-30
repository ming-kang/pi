import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { addUsageToTotals, createUsageTotals, getAccountedUsages, type UsageTotals } from "../../core/usage-totals.ts";

export interface UsageSummary extends UsageTotals {
	latestCacheHitPercent: number | undefined;
}

/** Per-footer accounting cache. Persisted entries are append-only; every append moves the leaf. */
export class BranchUsage {
	private cached?: {
		manager: ReadonlySessionManager;
		sessionId: string;
		leafId: string | null;
		usage: UsageSummary;
	};

	invalidate(): void {
		this.cached = undefined;
	}

	read(manager: ReadonlySessionManager): UsageSummary {
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		if (this.cached?.manager === manager && this.cached.sessionId === sessionId && this.cached.leafId === leafId) {
			return this.cached.usage;
		}

		const entries = manager.getBranch();
		const totals = createUsageTotals();
		for (const usage of getAccountedUsages(entries)) addUsageToTotals(totals, usage);

		// CH belongs to the latest assistant request, including failures. Other
		// usage contributes to totals without replacing that request's cache rate.
		let latestCacheHitPercent: number | undefined;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const { input, cacheRead, cacheWrite } = entry.message.usage;
			const promptTokens = input + cacheRead + cacheWrite;
			if ((cacheRead > 0 || cacheWrite > 0) && promptTokens > 0) {
				latestCacheHitPercent = (cacheRead / promptTokens) * 100;
			}
			break;
		}

		const usage = { ...totals, latestCacheHitPercent };
		this.cached = { manager, sessionId, leafId, usage };
		return usage;
	}
}
