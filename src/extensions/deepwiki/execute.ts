import type { AgentToolResult, AgentToolUpdateCallback } from "../../core/extensions/types.ts";

import { callDeepWiki, type DeepWikiResponse } from "./client.ts";
import { extractPage, truncateContentsByPages } from "./contents.ts";
import { type DeepWikiAction, type DeepWikiParams, normalizeDeepWikiParams } from "./schema.ts";

export const DEEPWIKI_OUTPUT_CHAR_BUDGET = 120_000;
const CONTENTS_BODY_CHAR_BUDGET = DEEPWIKI_OUTPUT_CHAR_BUDGET - 2_000;

export interface DeepWikiDetails {
	action: DeepWikiAction;
	repoName: string;
	repoNames?: string[];
	question?: string;
	toolName?: string;
	outputLength?: number;
	cacheHit?: boolean;
	pageCount?: number;
	pageTitles?: string[];
	/** Resolved title and 1-based position of a single-page contents read. */
	requestedPage?: string;
	pageIndex?: number;
	/** Set when model-facing text was truncated to the character budget. */
	shownPages?: number;
	truncatedChars?: number;
	/** Legacy fields kept so older session entries still render. */
	sectionCount?: number;
	sectionTitles?: string[];
	errorMessage?: string;
}

function buildResult(
	params: DeepWikiParams,
	text: string,
	extra: Partial<DeepWikiDetails> = {},
): AgentToolResult<DeepWikiDetails> {
	const repoNames = Array.isArray(params.repoName) ? params.repoName : [params.repoName];
	return {
		content: [{ type: "text", text }],
		details: {
			action: params.action,
			repoName: repoNames.join(", "),
			...(repoNames.length > 1 ? { repoNames } : {}),
			...(params.question ? { question: params.question } : {}),
			...extra,
		},
	};
}

function boundDeepWikiOutput(
	text: string,
	action: DeepWikiAction,
): { text: string; truncated: boolean; truncatedChars: number } {
	if (text.length <= DEEPWIKI_OUTPUT_CHAR_BUDGET) return { text, truncated: false, truncatedChars: 0 };
	const notice = `\n\n[DeepWiki ${action} output truncated to ${DEEPWIKI_OUTPUT_CHAR_BUDGET} characters. Use a focused page or question request for the omitted content.]`;
	const keepLength = Math.max(0, DEEPWIKI_OUTPUT_CHAR_BUDGET - notice.length);
	const kept = text.slice(0, keepLength).trimEnd();
	return { text: `${kept}${notice}`, truncated: true, truncatedChars: text.length - kept.length };
}

export async function executeDeepWiki(
	params: DeepWikiParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<DeepWikiDetails> | undefined,
): Promise<AgentToolResult<DeepWikiDetails>> {
	const normalizedParams = normalizeDeepWikiParams(params);
	const repoLabel = Array.isArray(normalizedParams.repoName)
		? normalizedParams.repoName.join(", ")
		: normalizedParams.repoName;

	onUpdate?.(buildResult(normalizedParams, `Querying DeepWiki for ${repoLabel}...`));

	let response: DeepWikiResponse;
	try {
		response = await callDeepWiki(normalizedParams, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepWiki call failed: ${message}`);
	}

	const extra: Partial<DeepWikiDetails> = {
		toolName: response.toolName,
		outputLength: response.outputLength,
		...(response.cacheHit ? { cacheHit: true } : {}),
		...(response.pageTitles
			? {
					pageCount: response.pageTitles.length,
					pageTitles: response.pageTitles,
				}
			: {}),
	};

	// Bounded model-facing output: the cache keeps the full response
	// (outputLength/pageTitles describe it); only the returned text is cut.
	// truncateContentsByPages/extractPage are deterministic, so cached and
	// fresh calls produce identical text.
	let resultText = response.text;
	if (normalizedParams.action === "contents") {
		if (normalizedParams.page !== undefined) {
			// Single-page read: upstream has no per-page fetch, so slice the page
			// out of the (cached) full wiki locally.
			const lookup = extractPage(response.text, normalizedParams.page);
			if (!lookup.found) {
				if (lookup.titles.length === 0) {
					throw new Error(
						`page "${normalizedParams.page}" not found: this wiki has no page structure. Call contents without page.`,
					);
				}
				const list = lookup.titles.slice(0, 30).join("; ");
				const more = lookup.titles.length > 30 ? ` … +${lookup.titles.length - 30} more` : "";
				throw new Error(
					`page "${normalizedParams.page}" not found in ${repoLabel} wiki (${lookup.titles.length} pages).\nAvailable pages: ${list}${more}`,
				);
			}
			const truncation = truncateContentsByPages(lookup.found.text, CONTENTS_BODY_CHAR_BUDGET);
			resultText = truncation.text;
			extra.requestedPage = lookup.found.title;
			extra.pageIndex = lookup.found.index;
			if (truncation.truncated) extra.truncatedChars = truncation.truncatedChars;
		} else {
			const truncation = truncateContentsByPages(response.text, CONTENTS_BODY_CHAR_BUDGET);
			if (truncation.truncated) {
				resultText = truncation.text;
				extra.shownPages = truncation.shownPages;
				extra.truncatedChars = truncation.truncatedChars;
			}
		}
	}

	const bounded = boundDeepWikiOutput(resultText, normalizedParams.action);
	if (bounded.truncated) {
		resultText = bounded.text;
		extra.truncatedChars = Math.max(extra.truncatedChars ?? 0, bounded.truncatedChars);
	}
	return buildResult(normalizedParams, resultText, extra);
}
