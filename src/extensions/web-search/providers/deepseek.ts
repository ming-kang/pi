/**
 * deepseek.ts — DeepSeek Messages API search provider (claude-sonnet-search model with web_search_20250305).
 */

import type { DeepSeekMessagesResponse, ProviderSearchResult, WebSearchHit } from "../types.ts";
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

export async function searchDeepSeek(options: DeepSeekSearchOptions): Promise<ProviderSearchResult> {
	const endpoint = options.baseUrl || DEFAULT_DEEPSEEK_MESSAGES_ENDPOINT;
	const model = options.model || DEFAULT_DEEPSEEK_SEARCH_MODEL;

	const toolConfig = {
		type: "web_search_20250305",
		name: "web_search",
	};

	const data = await postJson<DeepSeekMessagesResponse>(
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
			tools: [toolConfig],
		},
		options.signal,
		90_000,
		"DeepSeek Messages search API",
	);

	if (data.error) {
		throw new Error(`DeepSeek search error: ${data.error.message || data.error.type || "Unknown error"}`);
	}

	const hits: WebSearchHit[] = [];
	let synthesisText = "";

	for (const block of data.content || []) {
		if (block.type === "web_search_tool_result") {
			const toolResultBlock = block as {
				content?: { type?: string; title?: string; url?: string; page_age?: string }[];
			};
			for (const item of toolResultBlock.content || []) {
				if (item.url && typeof item.url === "string") {
					hits.push({
						title: item.title?.trim() || item.url.trim(),
						url: item.url.trim(),
						date: item.page_age || undefined,
						sources: ["DeepSeek"],
					});
				}
			}
		} else if (block.type === "text") {
			const textBlock = block as { text?: string };
			if (textBlock.text) {
				synthesisText += (synthesisText ? "\n\n" : "") + textBlock.text.trim();
			}
		}
	}

	return {
		source: "DeepSeek",
		hits,
		synthesisText: synthesisText || undefined,
	};
}
