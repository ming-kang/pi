/**
 * constants.ts — web_search tool identity, descriptions, and model-facing guidelines.
 */

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_LABEL = "Web Search";

export const WEB_SEARCH_DESCRIPTION =
	"Search the web for real-time information, documentation, libraries, technical references, and current events beyond the model's knowledge cutoff. Supports domain filtering with allowed_domains and blocked_domains.";

export const WEB_SEARCH_PROMPT_SNIPPET =
	"Search the web for real-time information, documentation, and external references";

export const WEB_SEARCH_DISABLED_MESSAGE =
	"Web search is disabled: Neither MiniMax nor DeepSeek API Key was found in auth.json or environment variables. Please add credentials via auth.json or environment variables (MINIMAX_API_KEY, DEEPSEEK_API_KEY).";

export function getWebSearchPromptGuidelines(): string[] {
	const currentYearMonth = new Date().toISOString().slice(0, 7);
	return [
		"Use `web_search` to query live web documentation, external technical issues, release notes, and real-time facts beyond your training cutoff.",
		"CRITICAL REQUIREMENT: After answering the user's question, you MUST include a 'Sources:' section at the end of your response listing all relevant URLs from the search results as markdown hyperlinks: [Title](URL).",
		`IMPORTANT: The current date is ${currentYearMonth}. Use the current year in search queries when seeking recent documentation, releases, or current events.`,
	];
}
