/**
 * minimax.ts — MiniMax Coding Plan Search REST API provider.
 */

import { MAX_PROVIDER_HIT_SCAN, MAX_PROVIDER_RELATED_SCAN, MAX_RELATED_SEARCHES } from "../results.ts";
import type { ProviderSearchResult, WebSearchHit } from "../types.ts";
import { postJson } from "./http.ts";

export interface MiniMaxSearchOptions {
	query: string;
	apiKey: string;
	apiHost?: string;
	signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseSearchHit(value: unknown): WebSearchHit | undefined {
	if (!isRecord(value)) return undefined;
	const url = stringField(value, "link")?.trim();
	if (!url) return undefined;
	return {
		title: stringField(value, "title")?.trim() || url,
		url,
		snippet: stringField(value, "snippet")?.trim() || undefined,
		date: stringField(value, "date")?.trim() || undefined,
		sources: ["MiniMax"],
	};
}

export async function searchMiniMax(options: MiniMaxSearchOptions): Promise<ProviderSearchResult> {
	const host = options.apiHost?.replace(/\/+$/, "") || "https://api.minimaxi.com";
	const rawData = await postJson<unknown>(
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
	const data = isRecord(rawData) ? rawData : {};
	const baseResponse = isRecord(data.base_resp) ? data.base_resp : undefined;
	const statusCode = baseResponse?.status_code;
	if (baseResponse && typeof statusCode === "number" && statusCode !== 0) {
		throw new Error(
			`MiniMax search failed: [${statusCode}] ${stringField(baseResponse, "status_msg") ?? "Unknown error"}`,
		);
	}

	const hits: WebSearchHit[] = [];
	const organic = Array.isArray(data.organic) ? data.organic : [];
	const hitScanLimit = Math.min(organic.length, MAX_PROVIDER_HIT_SCAN);
	for (let index = 0; index < hitScanLimit; index++) {
		const hit = parseSearchHit(organic[index]);
		if (hit) hits.push(hit);
	}

	const relatedSearches: string[] = [];
	const related = Array.isArray(data.related_searches) ? data.related_searches : [];
	const relatedScanLimit = Math.min(related.length, MAX_PROVIDER_RELATED_SCAN);
	for (let index = 0; index < relatedScanLimit && relatedSearches.length < MAX_RELATED_SEARCHES; index++) {
		const value = related[index];
		const query = isRecord(value) ? stringField(value, "query")?.trim() : undefined;
		if (query) relatedSearches.push(query);
	}

	return {
		source: "MiniMax",
		hits,
		relatedSearches: relatedSearches.length > 0 ? relatedSearches : undefined,
	};
}
