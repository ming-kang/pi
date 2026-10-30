import type { CallToolResult, TextContent } from "@earendil-works/pi-mcp";
import { PAGE_HEADER_RE } from "./contents.ts";
import { type DeepWikiParams, normalizeDeepWikiParams } from "./schema.ts";
import { callDeepWikiTool } from "./transport.ts";

const CACHE_TTL_MS = 10 * 60_000;
/** Long-lived process guard: entries are only otherwise dropped on re-read after expiry. */
const MAX_CACHE_ENTRIES = 50;

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

export interface DeepWikiResponse {
	toolName: DeepWikiToolName;
	text: string;
	outputLength: number;
	pageTitles?: string[];
	cacheHit?: boolean;
}

interface CacheEntry {
	expiresAt: number;
	response: DeepWikiResponse;
}

const responseCache = new Map<string, CacheEntry>();

function toolNameForAction(action: DeepWikiParams["action"]): DeepWikiToolName {
	if (action === "structure") return "read_wiki_structure";
	if (action === "contents") return "read_wiki_contents";
	return "ask_question";
}

// Callers pass params already normalized by callDeepWiki's entry gate; no re-normalization.
function argumentsForParams(params: DeepWikiParams): Record<string, unknown> {
	if (params.action === "question") {
		const question = params.question?.trim();
		if (!question) throw new Error("question is required when action is question");
		return { repoName: params.repoName, question };
	}
	return { repoName: params.repoName };
}

function cacheKey(params: DeepWikiParams): string {
	const repos = Array.isArray(params.repoName) ? params.repoName : [params.repoName];
	return JSON.stringify([params.action, repos, params.question ?? ""]);
}

function cloneResponse(response: DeepWikiResponse, cacheHit: boolean): DeepWikiResponse {
	return {
		...response,
		...(response.pageTitles ? { pageTitles: [...response.pageTitles] } : {}),
		cacheHit,
	};
}

function extractStructuredResult(result: Partial<CallToolResult>): string | undefined {
	if (!result.structuredContent || typeof result.structuredContent !== "object") return undefined;
	const value = (result.structuredContent as Record<string, unknown>).result;
	return typeof value === "string" ? value : undefined;
}

function extractContentResult(result: Partial<CallToolResult>): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((part): part is TextContent => {
			if (!part || typeof part !== "object") return false;
			const record = part as unknown as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function isDeepWikiErrorText(text: string): boolean {
	const trimmed = text.trim();
	return (
		/^Error fetching wiki for .+?: Repository not found\./i.test(trimmed) ||
		/^Error processing question: Repository not found\./i.test(trimmed)
	);
}

function extractToolText(result: unknown): string {
	if (!result || typeof result !== "object") throw new Error("DeepWiki returned no result object");

	const toolResult = result as Partial<CallToolResult>;
	const text = extractStructuredResult(toolResult) ?? extractContentResult(toolResult);
	if (!text) throw new Error("DeepWiki returned no text content");
	if (toolResult.isError || isDeepWikiErrorText(text)) throw new Error(text);
	return text;
}

export function extractStructureSections(text: string): string[] {
	return uniqueTitles(text.split("\n").map((line) => line.match(/^\s*-\s+\d+\s+(.+)$/)?.[1]?.trim()));
}

export function extractContentPages(text: string): string[] {
	return uniqueTitles(text.split("\n").map((line) => line.match(PAGE_HEADER_RE)?.[1]?.trim()));
}

function uniqueTitles(titles: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const title of titles) {
		if (!title || seen.has(title)) continue;
		seen.add(title);
		result.push(title);
	}
	return result;
}

function extractPageTitles(toolName: DeepWikiToolName, text: string): string[] {
	if (toolName === "read_wiki_structure") return extractStructureSections(text);
	if (toolName === "read_wiki_contents") return extractContentPages(text);
	return [];
}

export async function callDeepWiki(params: DeepWikiParams, signal: AbortSignal | undefined): Promise<DeepWikiResponse> {
	signal?.throwIfAborted();
	const normalizedParams = normalizeDeepWikiParams(params);
	const key = cacheKey(normalizedParams);
	const cached = responseCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cloneResponse(cached.response, true);
	}
	if (cached) responseCache.delete(key);

	const toolName = toolNameForAction(normalizedParams.action);
	const result = await callDeepWikiTool(toolName, argumentsForParams(normalizedParams), signal);
	signal?.throwIfAborted();

	const resultText = extractToolText(result);
	const pageTitles = extractPageTitles(toolName, resultText);
	const response: DeepWikiResponse = {
		toolName,
		text: resultText,
		outputLength: resultText.length,
		...(pageTitles.length ? { pageTitles } : {}),
	};
	signal?.throwIfAborted();
	responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response: cloneResponse(response, false) });
	while (responseCache.size > MAX_CACHE_ENTRIES) {
		const oldest = responseCache.keys().next().value;
		if (oldest === undefined) break;
		responseCache.delete(oldest);
	}
	return response;
}
