/**
 * deepseek.ts — DeepSeek Messages API search provider (claude-sonnet-search model with web_search_20250305).
 */

import type { ProviderSearchResult, WebSearchHit } from "../types.ts";
import { postJson } from "./http.ts";

export interface DeepSeekSearchOptions {
	query: string;
	apiKey: string;
	baseUrl?: string;
	model?: string;
	signal?: AbortSignal;
}

const DEFAULT_DEEPSEEK_MESSAGES_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const DEFAULT_DEEPSEEK_SEARCH_MODEL = "claude-sonnet-search";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseSearchHit(value: unknown): WebSearchHit | undefined {
	if (!isRecord(value) || value.type !== "web_search_result") return undefined;
	const url = stringField(value, "url")?.trim();
	if (!url) return undefined;
	const title = stringField(value, "title")?.trim();
	const pageAge = stringField(value, "page_age")?.trim();
	return {
		title: title || url,
		url,
		date: pageAge || undefined,
		sources: ["DeepSeek"],
	};
}

function errorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return stringField(value, "message") || stringField(value, "type") || "Unknown error";
}

export async function searchDeepSeek(options: DeepSeekSearchOptions): Promise<ProviderSearchResult> {
	const endpoint = options.baseUrl || DEFAULT_DEEPSEEK_MESSAGES_ENDPOINT;
	const model = options.model || DEFAULT_DEEPSEEK_SEARCH_MODEL;
	const rawData = await postJson<unknown>(
		endpoint,
		{
			"Content-Type": "application/json",
			"x-api-key": options.apiKey,
			Authorization: `Bearer ${options.apiKey}`,
			"anthropic-version": "2023-06-01",
		},
		{
			model,
			max_tokens: 1024,
			messages: [{ role: "user", content: options.query }],
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		},
		options.signal,
		90_000,
		"DeepSeek Messages search API",
	);
	const data = isRecord(rawData) ? rawData : {};
	const upstreamError = errorMessage(data.error);
	if (upstreamError) throw new Error(`DeepSeek search error: ${upstreamError}`);

	const hits: WebSearchHit[] = [];
	const synthesisParts: string[] = [];
	const content = Array.isArray(data.content) ? data.content : [];
	for (const value of content) {
		if (!isRecord(value)) continue;
		if (value.type === "web_search_tool_result") {
			if (!Array.isArray(value.content)) continue;
			for (const item of value.content) {
				const hit = parseSearchHit(item);
				if (hit) hits.push(hit);
			}
			continue;
		}
		if (value.type === "text") {
			const text = stringField(value, "text")?.trim();
			if (text) synthesisParts.push(text);
		}
	}

	return {
		source: "DeepSeek",
		hits,
		synthesisText: synthesisParts.length > 0 ? synthesisParts.join("\n\n") : undefined,
	};
}
