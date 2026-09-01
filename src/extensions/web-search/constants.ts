/**
 * constants.ts — web_search tool identity, descriptions, and model-facing guidelines.
 */

import type { SearchEngineType } from "./types.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_LABEL = "Web Search";

export const WEB_SEARCH_DESCRIPTION =
	"Search the live web through configured MiniMax and DeepSeek providers. When both are available, searches run concurrently and results are deduplicated and fused. Returns up to 12 source URLs with snippets, plus related searches and optional synthesis; partial provider failures still return successful results.";

export const WEB_SEARCH_PROMPT_SNIPPET = "Search the live web for current information";

export const WEB_SEARCH_DISABLED_MESSAGE =
	"Web search is disabled: Neither MiniMax nor DeepSeek API Key was found in auth.json or environment variables. Please add credentials via auth.json or environment variables (MINIMAX_API_KEY, DEEPSEEK_API_KEY).";

/** Canonical display label for the contributing engine set ("" when none). */
export function getEngineLabel(engine: SearchEngineType | undefined): string {
	if (engine === "dual") return "MiniMax & DeepSeek";
	if (engine === "minimax") return "MiniMax";
	if (engine === "deepseek") return "DeepSeek";
	return "";
}

export function getWebSearchPromptGuidelines(): string[] {
	const currentYearMonth = new Date().toISOString().slice(0, 7);
	return [
		"Use `web_search` for current information, recent releases, live documentation, and other freshness-sensitive facts beyond your training cutoff.",
		`When using \`web_search\` for freshness-sensitive topics, account for the current date (${currentYearMonth}) and include the year in the query when useful.`,
	];
}
