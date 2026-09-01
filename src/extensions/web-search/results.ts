/**
 * Result normalization, bounding, deduplication, and ranking for web_search providers.
 */

import type { ProviderSearchResult, SearchEngineSource, WebSearchHit } from "./types.ts";

export const MAX_OUTPUT_HITS = 12;
export const MAX_QUERY_LENGTH = 500;
export const MAX_TITLE_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
export const MAX_SNIPPET_LENGTH = 200;
export const MAX_DATE_LENGTH = 100;
export const MAX_RELATED_SEARCHES = 8;
export const MAX_RELATED_SEARCH_LENGTH = 200;
export const MAX_SYNTHESIS_LENGTH = 6000;
export const MAX_ERROR_MESSAGE_LENGTH = 500;

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

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 3) return text.slice(0, maxLength);
	return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

/** Normalize and bound a provider-controlled single-line text field. */
export function boundSingleLineText(value: string | undefined, maxLength: number): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim();
	return normalized ? truncateText(normalized, maxLength) : undefined;
}

/** Trim and bound provider-controlled text that intentionally preserves lines. */
export function boundMultilineText(value: string | undefined, maxLength: number): string | undefined {
	const normalized = value?.trim();
	return normalized ? truncateText(normalized, maxLength) : undefined;
}

/** Normalize a usable HTTP(S) source URL without changing non-tracking query values. */
export function normalizeUrl(rawUrl: string): string | undefined {
	const trimmed = rawUrl.trim();
	if (!trimmed || trimmed.length > MAX_URL_LENGTH) return undefined;

	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		for (const parameter of TRACKING_PARAMS) {
			if (url.searchParams.has(parameter)) url.searchParams.delete(parameter);
		}
		if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
			url.pathname = url.pathname.replace(/\/+$/, "");
		}
		const normalized = url.toString();
		return normalized.length <= MAX_URL_LENGTH ? normalized : undefined;
	} catch {
		return undefined;
	}
}

function normalizeHit(hit: WebSearchHit, source: SearchEngineSource): WebSearchHit | undefined {
	const url = normalizeUrl(hit.url);
	if (!url) return undefined;

	return {
		title: boundSingleLineText(hit.title, MAX_TITLE_LENGTH) ?? url,
		url,
		snippet: boundSingleLineText(hit.snippet, MAX_SNIPPET_LENGTH),
		date: boundSingleLineText(hit.date, MAX_DATE_LENGTH),
		sources: [...new Set([...hit.sources, source])],
	};
}

function isUrlFallbackTitle(title: string, url: string): boolean {
	const normalizedTitle = normalizeUrl(title);
	return normalizedTitle !== undefined && normalizedTitle === normalizeUrl(url);
}

function reciprocalRankScore(candidate: FusionCandidate): number {
	let score = 0;
	for (const rank of candidate.ranks.values()) score += 1 / (RRF_K + rank);
	return score;
}

function bestRank(candidate: FusionCandidate): number {
	return Math.min(...candidate.ranks.values());
}

/** Bound provider results, deduplicate URLs, and rank them with reciprocal-rank fusion. */
export function fuseSearchHits(results: ProviderSearchResult[]): FusedSearchResults {
	const candidates = new Map<string, FusionCandidate>();
	const relatedSearches = new Set<string>();
	let deepseekSynthesis: string | undefined;

	for (const result of results) {
		for (const related of result.relatedSearches ?? []) {
			if (relatedSearches.size >= MAX_RELATED_SEARCHES) break;
			const normalized = boundSingleLineText(related, MAX_RELATED_SEARCH_LENGTH);
			if (normalized) relatedSearches.add(normalized);
		}
		const synthesis = boundMultilineText(result.synthesisText, MAX_SYNTHESIS_LENGTH);
		if (synthesis) deepseekSynthesis = synthesis;

		for (const [index, rawHit] of result.hits.entries()) {
			const hit = normalizeHit(rawHit, result.source);
			if (!hit) continue;
			const rank = index + 1;
			const existing = candidates.get(hit.url);

			if (!existing) {
				candidates.set(hit.url, { hit, ranks: new Map([[result.source, rank]]) });
				continue;
			}

			const previousRank = existing.ranks.get(result.source);
			if (previousRank === undefined || rank < previousRank) existing.ranks.set(result.source, rank);
			for (const source of hit.sources) {
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
