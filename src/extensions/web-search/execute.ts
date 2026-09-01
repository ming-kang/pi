/**
 * Provider orchestration and execution-state construction for web_search.
 */

import type { AgentToolUpdateCallback } from "../../core/extensions/types.ts";
import { configuredEngine } from "./auth.ts";
import { getEngineLabel, WEB_SEARCH_DISABLED_MESSAGE } from "./constants.ts";
import { formatSearchOutput } from "./format.ts";
import { searchDeepSeek } from "./providers/deepseek.ts";
import { searchMiniMax } from "./providers/minimax.ts";
import { fuseSearchHits } from "./results.ts";
import type { WebSearchParams } from "./schema.ts";
import type { ProviderSearchResult, ResolvedSearchCredentials, SearchEngineType, WebSearchDetails } from "./types.ts";

export interface WebSearchExecution {
	formattedOutput: string;
	details: WebSearchDetails;
}

/** Execute all configured search providers and combine their successful results. */
export async function executeWebSearch(
	params: WebSearchParams,
	credentials: ResolvedSearchCredentials,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
): Promise<WebSearchExecution> {
	const startTime = Date.now();
	const query = params.query.trim();
	const engine = configuredEngine(credentials);

	if (!query) {
		const details: WebSearchDetails = {
			query: "",
			durationMs: 0,
			status: "error",
			engine,
			totalHits: 0,
			hits: [],
			errorMessage: "Search query must not be empty.",
		};
		return { formattedOutput: formatSearchOutput(query, details), details };
	}

	if (engine === "none") {
		const details: WebSearchDetails = {
			query,
			durationMs: 0,
			status: "disabled",
			engine: "none",
			totalHits: 0,
			hits: [],
			errorMessage: WEB_SEARCH_DISABLED_MESSAGE,
		};
		return { formattedOutput: formatSearchOutput(query, details), details };
	}

	signal?.throwIfAborted();
	onUpdate?.({
		content: [{ type: "text", text: `Searching for "${query}" via ${getEngineLabel(engine)}...` }],
		details: {
			query,
			durationMs: 0,
			status: "success",
			engine,
			totalHits: 0,
			hits: [],
		},
	});

	const searches: Promise<ProviderSearchResult>[] = [];
	if (credentials.minimax) {
		searches.push(
			searchMiniMax({
				query,
				apiKey: credentials.minimax.key,
				apiHost: credentials.minimax.host,
				signal,
			}),
		);
	}
	if (credentials.deepseek) {
		searches.push(searchDeepSeek({ query, apiKey: credentials.deepseek.key, signal }));
	}

	const settledResults = await Promise.allSettled(searches);
	signal?.throwIfAborted();
	const durationMs = Date.now() - startTime;
	const successfulResults: ProviderSearchResult[] = [];
	const errors: string[] = [];

	for (const result of settledResults) {
		if (result.status === "fulfilled") successfulResults.push(result.value);
		else errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	}

	if (successfulResults.length === 0) {
		const details: WebSearchDetails = {
			query,
			durationMs,
			status: "error",
			engine,
			totalHits: 0,
			hits: [],
			errorMessage: errors.join(" | ") || "All search engines failed",
		};
		return { formattedOutput: formatSearchOutput(query, details), details };
	}

	const { hits, relatedSearches, deepseekSynthesis } = fuseSearchHits(successfulResults);
	const respondedSources = new Set(successfulResults.map((result) => result.source));
	const contributingEngine: SearchEngineType =
		respondedSources.size > 1 ? "dual" : respondedSources.has("MiniMax") ? "minimax" : "deepseek";
	const details: WebSearchDetails = {
		query,
		durationMs,
		status: "success",
		engine: contributingEngine,
		totalHits: hits.length,
		hits,
		relatedSearches,
		deepseekSynthesis,
	};

	return { formattedOutput: formatSearchOutput(query, details), details };
}
