/**
 * minimax.ts — MiniMax Coding Plan Search REST API provider.
 */

import type { MiniMaxSearchResponse, ProviderSearchResult, WebSearchHit } from "../types.ts";
import { postJson } from "./http.ts";

export interface MiniMaxSearchOptions {
	query: string;
	apiKey: string;
	apiHost?: string;
	signal?: AbortSignal;
}

export async function searchMiniMax(options: MiniMaxSearchOptions): Promise<ProviderSearchResult> {
	const host = options.apiHost?.replace(/\/+$/, "") || "https://api.minimaxi.com";

	const data = await postJson<MiniMaxSearchResponse>(
		`${host}/v1/coding_plan/search`,
		{
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		{ q: options.query.trim() },
		options.signal,
		60_000,
		"MiniMax search API",
	);

	if (data.base_resp && data.base_resp.status_code !== 0) {
		throw new Error(`MiniMax search failed: [${data.base_resp.status_code}] ${data.base_resp.status_msg}`);
	}

	const rawHits = data.organic || [];
	const hits: WebSearchHit[] = [];

	for (const item of rawHits) {
		if (!item.link || !item.link.trim()) continue;
		const cleanLink = item.link.trim();
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
