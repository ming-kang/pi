/**
 * Model-facing and expanded-TUI Markdown formatting for web_search results.
 */

import { getEngineLabel, WEB_SEARCH_DISABLED_MESSAGE } from "./constants.ts";
import {
	boundMultilineText,
	boundSingleLineText,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_HISTORICAL_HIT_SCAN,
	MAX_HISTORICAL_RELATED_SCAN,
	MAX_HISTORICAL_SOURCE_SCAN,
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

function canonicalSources(value: unknown): WebSearchHit["sources"] {
	if (!Array.isArray(value)) return [];
	const sources: WebSearchHit["sources"] = [];
	const scanLimit = Math.min(value.length, MAX_HISTORICAL_SOURCE_SCAN);
	for (let index = 0; index < scanLimit && sources.length < 2; index++) {
		const source = value[index];
		if ((source === "MiniMax" || source === "DeepSeek") && !sources.includes(source)) sources.push(source);
	}
	return sources;
}

function formatHit(value: unknown): FormattedHit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const hit = value as Record<string, unknown>;
	const url = normalizeUrl(hit.url);
	if (!url) return undefined;
	return {
		title: escapeMarkdownText(boundSingleLineText(hit.title, MAX_TITLE_LENGTH) ?? url),
		url,
		snippet: boundSingleLineText(hit.snippet, MAX_SNIPPET_LENGTH),
		sources: canonicalSources(hit.sources),
	};
}

function usableHits(details: WebSearchDetails): FormattedHit[] {
	const hits = Array.isArray(details.hits) ? details.hits : [];
	const formatted: FormattedHit[] = [];
	const scanLimit = Math.min(hits.length, MAX_HISTORICAL_HIT_SCAN);
	for (let index = 0; index < scanLimit && formatted.length < MAX_OUTPUT_HITS; index++) {
		const hit = formatHit(hits[index]);
		if (hit) formatted.push(hit);
	}
	return formatted;
}

/**
 * Sources, synthesis, and related-search sections shared by model output and
 * the expanded TUI. This function adds no model instructions.
 */
export function formatResultsMarkdown(details: WebSearchDetails): string {
	const parts: string[] = [];
	const hits = usableHits(details);

	if (hits.length > 0) {
		parts.push(`## Web Sources (${hits.length} found via ${getEngineLabel(details.engine)})\n`);

		hits.forEach((hit, index) => {
			const sourceTag = hit.sources.length > 1 ? ` — *(found by ${hit.sources.join(" & ")})*` : "";
			parts.push(`${index + 1}. **[${hit.title}](<${hit.url}>)**${sourceTag}`);
			if (hit.snippet) parts.push(`   - ${escapeMarkdownText(hit.snippet)}`);
		});
		parts.push("");
	}

	const synthesis = boundMultilineText(details.deepseekSynthesis, MAX_SYNTHESIS_LENGTH);
	if (synthesis) {
		parts.push("## DeepSeek Search Synthesis\n");
		parts.push(escapeMarkdownText(synthesis));
		parts.push("");
	}

	const relatedSearches: string[] = [];
	const historicalRelated = Array.isArray(details.relatedSearches) ? details.relatedSearches : [];
	const relatedScanLimit = Math.min(historicalRelated.length, MAX_HISTORICAL_RELATED_SCAN);
	for (let index = 0; index < relatedScanLimit && relatedSearches.length < MAX_RELATED_SEARCHES; index++) {
		const related = boundSingleLineText(historicalRelated[index], MAX_RELATED_SEARCH_LENGTH);
		if (related) relatedSearches.push(related);
	}
	if (relatedSearches.length > 0) {
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
