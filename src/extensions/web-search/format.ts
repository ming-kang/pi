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

function prepareHit(value: unknown): WebSearchHit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const hit = value as Record<string, unknown>;
	const url = normalizeUrl(hit.url);
	if (!url) return undefined;
	return {
		title: boundSingleLineText(hit.title, MAX_TITLE_LENGTH) ?? url,
		url,
		snippet: boundSingleLineText(hit.snippet, MAX_SNIPPET_LENGTH),
		sources: canonicalSources(hit.sources),
	};
}

function usableHits(details: WebSearchDetails): WebSearchHit[] {
	const hits = Array.isArray(details.hits) ? details.hits : [];
	const prepared: WebSearchHit[] = [];
	const scanLimit = Math.min(hits.length, MAX_HISTORICAL_HIT_SCAN);
	for (let index = 0; index < scanLimit && prepared.length < MAX_OUTPUT_HITS; index++) {
		const hit = prepareHit(hits[index]);
		if (hit) prepared.push(hit);
	}
	return prepared;
}

interface PreparedResults {
	engine: WebSearchDetails["engine"];
	hits: WebSearchHit[];
	synthesis?: string;
	relatedSearches: string[];
}

/** Historical details enter here; Markdown rendering only consumes bounded content. */
export function prepareResults(details: WebSearchDetails): PreparedResults {
	const relatedSearches: string[] = [];
	const historicalRelated = Array.isArray(details.relatedSearches) ? details.relatedSearches : [];
	const relatedScanLimit = Math.min(historicalRelated.length, MAX_HISTORICAL_RELATED_SCAN);
	for (let index = 0; index < relatedScanLimit && relatedSearches.length < MAX_RELATED_SEARCHES; index++) {
		const related = boundSingleLineText(historicalRelated[index], MAX_RELATED_SEARCH_LENGTH);
		if (related) relatedSearches.push(related);
	}
	return {
		engine: details.engine,
		hits: usableHits(details),
		synthesis: boundMultilineText(details.deepseekSynthesis, MAX_SYNTHESIS_LENGTH),
		relatedSearches,
	};
}

/**
 * Sources, synthesis, and related-search sections shared by model output and
 * the expanded TUI. This function adds no model instructions.
 */
export function formatResultsMarkdown({ engine, hits, synthesis, relatedSearches }: PreparedResults): string {
	const parts: string[] = [];

	if (hits.length > 0) {
		parts.push(`## Web Sources (${hits.length} found via ${getEngineLabel(engine)})\n`);

		hits.forEach((hit, index) => {
			const sourceTag = hit.sources.length > 1 ? ` — *(found by ${hit.sources.join(" & ")})*` : "";
			parts.push(`${index + 1}. **[${escapeMarkdownText(hit.title)}](<${hit.url}>)**${sourceTag}`);
			if (hit.snippet) parts.push(`   - ${escapeMarkdownText(hit.snippet)}`);
		});
		parts.push("");
	}

	if (synthesis) {
		parts.push("## DeepSeek Search Synthesis\n");
		parts.push(escapeMarkdownText(synthesis));
		parts.push("");
	}

	if (relatedSearches.length > 0) {
		parts.push("## Related Searches\n");
		parts.push(relatedSearches.map((related) => `- ${escapeMarkdownText(related)}`).join("\n"));
		parts.push("");
	}

	return parts.join("\n");
}

/** Format a structured result payload for the main agent. */
export function formatSearchOutput(details: WebSearchDetails): string {
	if (details.status === "disabled") return WEB_SEARCH_DISABLED_MESSAGE;

	const boundedQuery = boundSingleLineText(details.query, MAX_QUERY_LENGTH) ?? "";
	if (details.status === "error") {
		const errorMessage =
			boundSingleLineText(details.errorMessage, MAX_ERROR_MESSAGE_LENGTH) ?? "Unknown search error";
		return `Web search failed for "${boundedQuery}": ${errorMessage}`;
	}

	const prepared = prepareResults(details);
	const hasSources = prepared.hits.length > 0;
	const hasSynthesis = prepared.synthesis !== undefined;
	if (!hasSources && !hasSynthesis) {
		return `No search results found for "${boundedQuery}". Try rephrasing with different keywords.`;
	}

	const parts = [`# Web Search Results for: "${boundedQuery}"\n`, formatResultsMarkdown(prepared)];
	if (hasSources) {
		parts.push(
			"---",
			"Use these search results to answer the user, and cite the relevant source URLs in your response.",
		);
	}
	return parts.join("\n");
}
