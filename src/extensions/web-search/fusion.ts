/**
 * fusion.ts — Dual search engine concurrency dispatcher, URL deduplication, ranking, and formatter.
 */

import type { AgentToolUpdateCallback } from "../../core/extensions/types.ts";
import { WEB_SEARCH_DISABLED_MESSAGE } from "./constants.ts";
import { searchDeepSeek } from "./providers/deepseek.ts";
import { searchMiniMax } from "./providers/minimax.ts";
import type { WebSearchParams } from "./schema.ts";
import type {
	ProviderSearchResult,
	ResolvedSearchCredentials,
	SearchEngineSource,
	WebSearchDetails,
	WebSearchHit,
} from "./types.ts";

const MAX_OUTPUT_HITS = 12;
const MAX_SNIPPET_LENGTH = 200;
const MAX_RELATED_SEARCHES = 8;

/**
 * Normalize URL by removing common tracking parameters and fragments.
 */
export function normalizeUrl(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		// Remove hash
		u.hash = "";
		// Remove tracking query parameters
		const trackingParams = [
			"utm_source",
			"utm_medium",
			"utm_campaign",
			"utm_term",
			"utm_content",
			"ref",
			"fbclid",
			"gclid",
			"trk",
			"gi",
		];
		for (const p of trackingParams) {
			u.searchParams.delete(p);
		}
		let href = u.toString();
		if (href.endsWith("/") && u.pathname !== "/") {
			href = href.slice(0, -1);
		}
		return href;
	} catch {
		return rawUrl.trim();
	}
}

/**
 * Deduplicate and rank search hits from multiple search engines.
 */
export function fuseSearchHits(results: ProviderSearchResult[]): {
	hits: WebSearchHit[];
	relatedSearches?: string[];
	deepseekSynthesis?: string;
} {
	const hitMap = new Map<string, WebSearchHit>();
	const relatedSet = new Set<string>();
	let deepseekSynthesis: string | undefined;

	for (const result of results) {
		if (result.relatedSearches) {
			for (const r of result.relatedSearches) {
				if (relatedSet.size >= MAX_RELATED_SEARCHES) break;
				if (r?.trim()) relatedSet.add(r.trim());
			}
		}
		if (result.synthesisText) {
			deepseekSynthesis = result.synthesisText;
		}

		for (const hit of result.hits) {
			const normalized = normalizeUrl(hit.url);
			const existing = hitMap.get(normalized);

			if (existing) {
				for (const s of hit.sources) {
					if (!existing.sources.includes(s)) {
						existing.sources.push(s);
					}
				}
				// Prefer longer snippet or date if missing
				if ((!existing.snippet || existing.snippet.length < (hit.snippet?.length || 0)) && hit.snippet) {
					existing.snippet = hit.snippet;
				}
				if (!existing.date && hit.date) {
					existing.date = hit.date;
				}
			} else {
				hitMap.set(normalized, {
					...hit,
					url: normalized,
					sources: [...hit.sources],
				});
			}
		}
	}

	// Sort hits: items supported by multiple engines first, then preserve discovery order
	const fused = Array.from(hitMap.values()).sort((a, b) => {
		if (b.sources.length !== a.sources.length) {
			return b.sources.length - a.sources.length;
		}
		return 0;
	});

	return {
		hits: fused.slice(0, MAX_OUTPUT_HITS),
		relatedSearches: relatedSet.size > 0 ? Array.from(relatedSet) : undefined,
		deepseekSynthesis,
	};
}

/**
 * Format search results into a clean, structured Markdown payload for the Main Agent.
 */
export function formatSearchOutput(query: string, details: WebSearchDetails): string {
	if (details.status === "disabled") {
		return WEB_SEARCH_DISABLED_MESSAGE;
	}

	if (details.status === "error") {
		return `Web search failed for "${query}": ${details.errorMessage || "Unknown search error"}`;
	}

	if (details.hits.length === 0 && !details.deepseekSynthesis) {
		return `No search results found for "${query}". Try rephrasing with different keywords.`;
	}

	const parts: string[] = [];
	parts.push(`# Web Search Results for: "${query}"\n`);

	if (details.hits.length > 0) {
		const engineLabel =
			details.engine === "dual" ? "MiniMax & DeepSeek" : details.engine === "minimax" ? "MiniMax" : "DeepSeek";

		parts.push(`## Verified Web Sources (${details.hits.length} found via ${engineLabel})\n`);

		details.hits.forEach((hit, idx) => {
			const sourceTag = hit.sources.length > 1 ? ` — *(verified by ${hit.sources.join(" & ")})*` : "";
			parts.push(`${idx + 1}. **[${hit.title}](${hit.url})**${sourceTag}`);
			if (hit.snippet) {
				const truncated =
					hit.snippet.length > MAX_SNIPPET_LENGTH
						? `${hit.snippet.slice(0, MAX_SNIPPET_LENGTH).trim()}...`
						: hit.snippet.trim();
				parts.push(`   - ${truncated}`);
			}
		});
		parts.push("");
	}

	if (details.deepseekSynthesis) {
		parts.push("## Key Technical Insights & Synthesis\n");
		parts.push(details.deepseekSynthesis.trim());
		parts.push("");
	}

	if (details.relatedSearches && details.relatedSearches.length > 0) {
		parts.push("## Related Searches\n");
		parts.push(details.relatedSearches.map((r) => `- ${r}`).join("\n"));
		parts.push("");
	}

	parts.push("---");
	parts.push(
		"**CRITICAL REQUIREMENT FOR MAIN AGENT:** Use the above search results to inform your response. You MUST include a `Sources:` section at the end of your response listing the relevant URLs as markdown links: `[Title](URL)`.",
	);

	return parts.join("\n");
}

/**
 * Execute web search across MiniMax and/or DeepSeek based on configured credentials.
 */
export async function executeWebSearch(
	params: WebSearchParams,
	credentials: ResolvedSearchCredentials,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
): Promise<{ formattedOutput: string; details: WebSearchDetails }> {
	const startTime = Date.now();
	const query = params.query.trim();

	if (!query) {
		const details: WebSearchDetails = {
			query: "",
			durationMs: 0,
			status: "error",
			engine: credentials.mode,
			totalHits: 0,
			hits: [],
			errorMessage: "Search query must not be empty.",
		};
		return {
			formattedOutput: formatSearchOutput(query, details),
			details,
		};
	}

	if (credentials.mode === "none") {
		const details: WebSearchDetails = {
			query,
			durationMs: 0,
			status: "disabled",
			engine: "none",
			totalHits: 0,
			hits: [],
			errorMessage: WEB_SEARCH_DISABLED_MESSAGE,
		};
		return {
			formattedOutput: formatSearchOutput(query, details),
			details,
		};
	}

	// Send initial progress update
	onUpdate?.({
		content: [{ type: "text", text: `Searching for "${query}" via ${credentials.mode.toUpperCase()}...` }],
		details: {
			query,
			durationMs: 0,
			status: "success",
			engine: credentials.mode,
			totalHits: 0,
			hits: [],
		},
	});

	const searchPromises: Promise<ProviderSearchResult>[] = [];

	if (credentials.minimaxKey) {
		searchPromises.push(
			searchMiniMax({
				query,
				apiKey: credentials.minimaxKey,
				apiHost: credentials.minimaxHost,
				allowedDomains: params.allowed_domains,
				blockedDomains: params.blocked_domains,
				signal,
			}),
		);
	}

	if (credentials.deepseekKey) {
		searchPromises.push(
			searchDeepSeek({
				query,
				apiKey: credentials.deepseekKey,
				allowedDomains: params.allowed_domains,
				blockedDomains: params.blocked_domains,
				signal,
			}),
		);
	}

	const settledResults = await Promise.allSettled(searchPromises);
	const durationMs = Date.now() - startTime;

	const successfulResults: ProviderSearchResult[] = [];
	const errors: string[] = [];

	for (const res of settledResults) {
		if (res.status === "fulfilled") {
			successfulResults.push(res.value);
		} else {
			errors.push(res.reason instanceof Error ? res.reason.message : String(res.reason));
		}
	}

	// If all engines failed
	if (successfulResults.length === 0) {
		const details: WebSearchDetails = {
			query,
			durationMs,
			status: "error",
			engine: credentials.mode,
			totalHits: 0,
			hits: [],
			errorMessage: errors.join(" | ") || "All search engines failed",
		};
		return {
			formattedOutput: formatSearchOutput(query, details),
			details,
		};
	}

	const { hits, relatedSearches, deepseekSynthesis } = fuseSearchHits(successfulResults);

	// Determine actual contributing engines
	const usedSources = new Set<SearchEngineSource>();
	for (const h of hits) {
		for (const s of h.sources) usedSources.add(s);
	}
	if (deepseekSynthesis) usedSources.add("DeepSeek");

	let effectiveEngine: typeof credentials.mode = credentials.mode;
	if (usedSources.has("MiniMax") && usedSources.has("DeepSeek")) {
		effectiveEngine = "dual";
	} else if (usedSources.has("MiniMax")) {
		effectiveEngine = "minimax";
	} else if (usedSources.has("DeepSeek")) {
		effectiveEngine = "deepseek";
	}

	const details: WebSearchDetails = {
		query,
		durationMs,
		status: "success",
		engine: effectiveEngine,
		totalHits: hits.length,
		hits,
		relatedSearches,
		deepseekSynthesis,
	};

	return {
		formattedOutput: formatSearchOutput(query, details),
		details,
	};
}
