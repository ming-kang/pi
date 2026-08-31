/**
 * minimax.ts — MiniMax Coding Plan Search REST API provider.
 */

import type { MiniMaxSearchResponse, ProviderSearchResult, WebSearchHit } from "../types.ts";

export interface MiniMaxSearchOptions {
	query: string;
	apiKey: string;
	apiHost?: string;
	signal?: AbortSignal;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

function buildSearchQuery(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	let q = query.trim();
	if (allowedDomains && allowedDomains.length > 0) {
		const siteFilter = allowedDomains.map((d) => `site:${d.trim()}`).join(" OR ");
		q = `${q} (${siteFilter})`;
	} else if (blockedDomains && blockedDomains.length > 0) {
		const blockFilter = blockedDomains.map((d) => `-site:${d.trim()}`).join(" ");
		q = `${q} ${blockFilter}`;
	}
	return q;
}

function matchesDomainFilters(url: string, allowedDomains?: string[], blockedDomains?: string[]): boolean {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		if (allowedDomains && allowedDomains.length > 0) {
			return allowedDomains.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`));
		}
		if (blockedDomains && blockedDomains.length > 0) {
			return !blockedDomains.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`));
		}
		return true;
	} catch {
		return true;
	}
}

export async function searchMiniMax(options: MiniMaxSearchOptions): Promise<ProviderSearchResult> {
	const host = options.apiHost?.replace(/\/+$/, "") || "https://api.minimaxi.com";
	const effectiveQuery = buildSearchQuery(options.query, options.allowedDomains, options.blockedDomains);

	const response = await fetch(`${host}/v1/coding_plan/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({ q: effectiveQuery }),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`MiniMax search API returned HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, 200)}`,
		);
	}

	const data = (await response.json()) as MiniMaxSearchResponse;

	if (data.base_resp && data.base_resp.status_code !== 0) {
		throw new Error(`MiniMax search failed: [${data.base_resp.status_code}] ${data.base_resp.status_msg}`);
	}

	const rawHits = data.organic || [];
	const hits: WebSearchHit[] = [];

	for (const item of rawHits) {
		if (!item.link || !item.link.trim()) continue;
		const cleanLink = item.link.trim();
		if (!matchesDomainFilters(cleanLink, options.allowedDomains, options.blockedDomains)) {
			continue;
		}
		hits.push({
			title: item.title?.trim() || cleanLink,
			url: cleanLink,
			snippet: item.snippet?.trim() || undefined,
			date: item.date?.trim() || undefined,
			sources: ["MiniMax"],
		});
	}

	const relatedSearches = data.related_searches
		?.map((r) => r.query?.trim())
		.filter((q): q is string => Boolean(q && q.length > 0));

	return {
		source: "MiniMax",
		hits,
		relatedSearches: relatedSearches && relatedSearches.length > 0 ? relatedSearches : undefined,
	};
}
