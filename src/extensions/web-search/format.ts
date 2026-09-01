/**
 * Model-facing and expanded-TUI Markdown formatting for web_search results.
 */

import { getEngineLabel, WEB_SEARCH_DISABLED_MESSAGE } from "./constants.ts";
import {
	boundMultilineText,
	boundSingleLineText,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_OUTPUT_HITS,
	MAX_QUERY_LENGTH,
	MAX_RELATED_SEARCH_LENGTH,
	MAX_RELATED_SEARCHES,
	MAX_SNIPPET_LENGTH,
	MAX_SYNTHESIS_LENGTH,
	MAX_TITLE_LENGTH,
	normalizeUrl,
} from "./results.ts";
import type { WebSearchDetails, WebSearchHit } from "./types.ts";

interface FormattedHit {
	title: string;
	url: string;
	snippet?: string;
	sources: WebSearchHit["sources"];
}

function escapeMarkdownText(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/</g, "\\<")
		.replace(/>/g, "\\>");
}

function formatHit(hit: WebSearchHit): FormattedHit | undefined {
	const url = normalizeUrl(hit.url);
	if (!url) return undefined;
	const sources = Array.isArray(hit.sources)
		? [...new Set(hit.sources.filter((source) => source === "MiniMax" || source === "DeepSeek"))]
		: [];
	return {
		title: escapeMarkdownText(boundSingleLineText(hit.title, MAX_TITLE_LENGTH) ?? url),
		url,
		snippet: boundSingleLineText(hit.snippet, MAX_SNIPPET_LENGTH),
		sources,
	};
}

function usableHits(details: WebSearchDetails): FormattedHit[] {
	return details.hits
		.map(formatHit)
		.filter((hit): hit is FormattedHit => hit !== undefined)
		.slice(0, MAX_OUTPUT_HITS);
}

/**
 * Sources, synthesis, and related-search sections shared by model output and
 * the expanded TUI. This function adds no model instructions.
 */
export function formatResultsMarkdown(details: WebSearchDetails): string {
	const parts: string[] = [];
	const hits = usableHits(details);

	if (hits.length > 0) {
		parts.push(`## Verified Web Sources (${hits.length} found via ${getEngineLabel(details.engine)})\n`);

		hits.forEach((hit, index) => {
			const sourceTag = hit.sources.length > 1 ? ` — *(verified by ${hit.sources.join(" & ")})*` : "";
			parts.push(`${index + 1}. **[${hit.title}](<${hit.url}>)**${sourceTag}`);
			if (hit.snippet) parts.push(`   - ${escapeMarkdownText(hit.snippet)}`);
		});
		parts.push("");
	}

	const synthesis = boundMultilineText(details.deepseekSynthesis, MAX_SYNTHESIS_LENGTH);
	if (synthesis) {
		parts.push("## Key Technical Insights & Synthesis\n");
		parts.push(escapeMarkdownText(synthesis));
		parts.push("");
	}

	const relatedSearches = details.relatedSearches
		?.map((related) => boundSingleLineText(related, MAX_RELATED_SEARCH_LENGTH))
		.filter((related): related is string => related !== undefined)
		.slice(0, MAX_RELATED_SEARCHES);
	if (relatedSearches && relatedSearches.length > 0) {
		parts.push("## Related Searches\n");
		parts.push(relatedSearches.map((related) => `- ${escapeMarkdownText(related)}`).join("\n"));
		parts.push("");
	}

	return parts.join("\n");
}

/** Format a structured result payload for the main agent. */
export function formatSearchOutput(query: string, details: WebSearchDetails): string {
	if (details.status === "disabled") return WEB_SEARCH_DISABLED_MESSAGE;

	const boundedQuery = boundSingleLineText(query, MAX_QUERY_LENGTH) ?? "";
	if (details.status === "error") {
		const errorMessage =
			boundSingleLineText(details.errorMessage, MAX_ERROR_MESSAGE_LENGTH) ?? "Unknown search error";
		return `Web search failed for "${boundedQuery}": ${errorMessage}`;
	}

	const hasSources = usableHits(details).length > 0;
	const hasSynthesis = boundMultilineText(details.deepseekSynthesis, MAX_SYNTHESIS_LENGTH) !== undefined;
	if (!hasSources && !hasSynthesis) {
		return `No search results found for "${boundedQuery}". Try rephrasing with different keywords.`;
	}

	const parts = [`# Web Search Results for: "${boundedQuery}"\n`, formatResultsMarkdown(details)];
	if (hasSources) {
		parts.push(
			"---",
			"Use these search results to answer the user, and cite the relevant source URLs in your response.",
		);
	}
	return parts.join("\n");
}
