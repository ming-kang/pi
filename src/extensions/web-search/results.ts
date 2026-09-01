/**
 * Result normalization, deduplication, and ranking for web_search providers.
 */

import type { ProviderSearchResult, SearchEngineSource, WebSearchHit } from "./types.ts";

const MAX_OUTPUT_HITS = 12;
const MAX_RELATED_SEARCHES = 8;
const RRF_K = 60;
const TRACKING_PARAMS = new Set([
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
]);

interface FusionCandidate {
	hit: WebSearchHit;
	ranks: Map<SearchEngineSource, number>;
}

export interface FusedSearchResults {
	hits: WebSearchHit[];
	relatedSearches?: string[];
	deepseekSynthesis?: string;
}

/** Normalize URL identity without changing non-tracking query values. */
export function normalizeUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.hash = "";
		for (const parameter of TRACKING_PARAMS) {
			if (url.searchParams.has(parameter)) url.searchParams.delete(parameter);
		}
		if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.replace(/\/+$/, "");
		}
		return url.toString();
	} catch {
		return rawUrl.trim();
	}
}

function isUrlFallbackTitle(title: string, url: string): boolean {
	return normalizeUrl(title) === normalizeUrl(url);
}

function reciprocalRankScore(candidate: FusionCandidate): number {
	let score = 0;
	for (const rank of candidate.ranks.values()) {
		score += 1 / (RRF_K + rank);
	}
	return score;
}

function bestRank(candidate: FusionCandidate): number {
	return Math.min(...candidate.ranks.values());
}

/** Deduplicate provider hits and rank them with reciprocal-rank fusion. */
export function fuseSearchHits(results: ProviderSearchResult[]): FusedSearchResults {
	const candidates = new Map<string, FusionCandidate>();
	const relatedSearches = new Set<string>();
	let deepseekSynthesis: string | undefined;

	for (const result of results) {
		for (const related of result.relatedSearches ?? []) {
			if (relatedSearches.size >= MAX_RELATED_SEARCHES) break;
			const normalized = related.trim();
			if (normalized) relatedSearches.add(normalized);
		}
		if (result.synthesisText) deepseekSynthesis = result.synthesisText;

		for (const [index, hit] of result.hits.entries()) {
			const normalizedUrl = normalizeUrl(hit.url);
			const rank = index + 1;
			const existing = candidates.get(normalizedUrl);

			if (!existing) {
				const sources = [...new Set([...hit.sources, result.source])];
				candidates.set(normalizedUrl, {
					hit: { ...hit, url: normalizedUrl, sources },
					ranks: new Map([[result.source, rank]]),
				});
				continue;
			}

			const previousRank = existing.ranks.get(result.source);
			if (previousRank === undefined || rank < previousRank) {
				existing.ranks.set(result.source, rank);
			}
			for (const source of [...hit.sources, result.source]) {
				if (!existing.hit.sources.includes(source)) existing.hit.sources.push(source);
			}
			if (isUrlFallbackTitle(existing.hit.title, existing.hit.url) && !isUrlFallbackTitle(hit.title, hit.url)) {
				existing.hit.title = hit.title;
			}
			if ((!existing.hit.snippet || existing.hit.snippet.length < (hit.snippet?.length ?? 0)) && hit.snippet) {
				existing.hit.snippet = hit.snippet;
			}
			if (!existing.hit.date && hit.date) existing.hit.date = hit.date;
		}
	}

	const ranked = [...candidates.entries()]
		.sort(([leftUrl, left], [rightUrl, right]) => {
			const scoreDifference = reciprocalRankScore(right) - reciprocalRankScore(left);
			if (scoreDifference !== 0) return scoreDifference;
			const rankDifference = bestRank(left) - bestRank(right);
			if (rankDifference !== 0) return rankDifference;
			return leftUrl.localeCompare(rightUrl);
		})
		.map(([, candidate]) => candidate.hit)
		.slice(0, MAX_OUTPUT_HITS);

	return {
		hits: ranked,
		relatedSearches: relatedSearches.size > 0 ? [...relatedSearches] : undefined,
		deepseekSynthesis,
	};
}
