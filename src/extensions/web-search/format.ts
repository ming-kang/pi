/**
 * Model-facing and expanded-TUI Markdown formatting for web_search results.
 */

import { getEngineLabel, WEB_SEARCH_DISABLED_MESSAGE } from "./constants.ts";
import type { WebSearchDetails } from "./types.ts";

const MAX_SNIPPET_LENGTH = 200;

/**
 * Sources, synthesis, and related-search sections shared by model output and
 * the expanded TUI. This function adds no model instructions.
 */
export function formatResultsMarkdown(details: WebSearchDetails): string {
	const parts: string[] = [];

	if (details.hits.length > 0) {
		parts.push(`## Verified Web Sources (${details.hits.length} found via ${getEngineLabel(details.engine)})\n`);

		details.hits.forEach((hit, index) => {
			const sourceTag = hit.sources.length > 1 ? ` — *(verified by ${hit.sources.join(" & ")})*` : "";
			parts.push(`${index + 1}. **[${hit.title}](${hit.url})**${sourceTag}`);
			if (hit.snippet) {
				const snippet =
					hit.snippet.length > MAX_SNIPPET_LENGTH
						? `${hit.snippet.slice(0, MAX_SNIPPET_LENGTH).trim()}...`
						: hit.snippet.trim();
				parts.push(`   - ${snippet}`);
			}
		});
		parts.push("");
	}

	if (details.deepseekSynthesis) {
		parts.push("## Key Technical Insights & Synthesis\n");
		parts.push(details.deepseekSynthesis.trim());
		parts.push("");
	}

	if (details.relatedSearches && details.relatedSearches.length > 0) {
		parts.push("## Related Searches\n");
		parts.push(details.relatedSearches.map((related) => `- ${related}`).join("\n"));
		parts.push("");
	}

	return parts.join("\n");
}

/** Format a structured result payload for the main agent. */
export function formatSearchOutput(query: string, details: WebSearchDetails): string {
	if (details.status === "disabled") return WEB_SEARCH_DISABLED_MESSAGE;

	if (details.status === "error") {
		return `Web search failed for "${query}": ${details.errorMessage || "Unknown search error"}`;
	}

	if (details.hits.length === 0 && !details.deepseekSynthesis) {
		return `No search results found for "${query}". Try rephrasing with different keywords.`;
	}

	const parts = [`# Web Search Results for: "${query}"\n`, formatResultsMarkdown(details)];
	if (details.hits.length > 0) {
		parts.push(
			"---",
			"Use these search results to answer the user, and cite the relevant source URLs in your response.",
		);
	}
	return parts.join("\n");
}
