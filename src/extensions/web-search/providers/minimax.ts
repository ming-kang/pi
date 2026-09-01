/**
 * minimax.ts — MiniMax Coding Plan Search REST API provider.
 */

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

	const hits = (Array.isArray(data.organic) ? data.organic : [])
		.map(parseSearchHit)
		.filter((hit): hit is WebSearchHit => hit !== undefined);
	const relatedSearches = (Array.isArray(data.related_searches) ? data.related_searches : [])
		.map((value) => (isRecord(value) ? stringField(value, "query")?.trim() : undefined))
		.filter((query): query is string => Boolean(query));

	return {
		source: "MiniMax",
		hits,
		relatedSearches: relatedSearches.length > 0 ? relatedSearches : undefined,
	};
}
