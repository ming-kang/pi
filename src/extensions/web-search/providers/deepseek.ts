/**
 * deepseek.ts — DeepSeek Messages API search provider (claude-sonnet-search model with web_search_20250305).
 */

import type { DeepSeekMessagesResponse, ProviderSearchResult, WebSearchHit } from "../types.ts";

export interface DeepSeekSearchOptions {
	query: string;
	apiKey: string;
	baseUrl?: string;
	model?: string;
	signal?: AbortSignal;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

const DEFAULT_DEEPSEEK_MESSAGES_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const DEFAULT_DEEPSEEK_SEARCH_MODEL = "claude-sonnet-search";

export async function searchDeepSeek(options: DeepSeekSearchOptions): Promise<ProviderSearchResult> {
	const endpoint = options.baseUrl || DEFAULT_DEEPSEEK_MESSAGES_ENDPOINT;
	const model = options.model || DEFAULT_DEEPSEEK_SEARCH_MODEL;

	const toolConfig: Record<string, unknown> = {
		type: "web_search_20250305",
		name: "web_search",
	};

	if (options.allowedDomains && options.allowedDomains.length > 0) {
		toolConfig.allowed_domains = options.allowedDomains;
	} else if (options.blockedDomains && options.blockedDomains.length > 0) {
		toolConfig.blocked_domains = options.blockedDomains;
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": options.apiKey,
			Authorization: `Bearer ${options.apiKey}`,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: 1024,
			messages: [{ role: "user", content: options.query }],
			tools: [toolConfig],
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`DeepSeek Messages search API returned HTTP ${response.status} ${response.statusText}: ${errorText.slice(0, 200)}`,
		);
	}

	const data = (await response.json()) as DeepSeekMessagesResponse;

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
