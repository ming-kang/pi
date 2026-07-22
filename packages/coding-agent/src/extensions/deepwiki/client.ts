import { PAGE_HEADER_RE } from "./contents.ts";
import { fetchWithRetry } from "./http.ts";
import { type DeepWikiParams, normalizeDeepWikiParams } from "./schema.ts";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 10 * 60_000;
/** Long-lived process guard: entries are only otherwise dropped on re-read after expiry. */
const MAX_CACHE_ENTRIES = 50;
/** Transient-failure retries (network blips, 5xx, 429). Aborts/timeouts are not retried. */
const MAX_RETRIES = 2;

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

interface JsonRpcErrorPayload {
	code?: number;
	message?: string;
	data?: unknown;
}

interface JsonRpcEnvelope {
	jsonrpc?: string;
	id?: string | number | null;
	result?: unknown;
	error?: JsonRpcErrorPayload;
}

interface McpTextContent {
	type: "text";
	text: string;
}

interface McpToolCallResult {
	content?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

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

function truncate(text: string, maxLength = 500): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function parseJson(text: string): JsonRpcEnvelope {
	try {
		return JSON.parse(text) as JsonRpcEnvelope;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepWiki returned invalid JSON: ${message}`);
	}
}

function parseSse(text: string): JsonRpcEnvelope {
	const blocks = text.split(/\r?\n\r?\n/);
	let fallback: JsonRpcEnvelope | undefined;
	for (const block of blocks) {
		const dataLines = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""));
		if (dataLines.length === 0) continue;

		const data = dataLines.join("\n").trim();
		if (!data || data === "[DONE]") continue;
		const envelope = parseJson(data);
		if (envelope.error || envelope.result !== undefined) return envelope;
		fallback = envelope;
	}
	if (fallback) return fallback;
	throw new Error("DeepWiki returned an empty event stream");
}

function parseEnvelope(text: string, contentType: string | null): JsonRpcEnvelope {
	if (contentType?.includes("text/event-stream")) return parseSse(text);
	return parseJson(text);
}

function extractStructuredResult(result: McpToolCallResult): string | undefined {
	if (!result.structuredContent || typeof result.structuredContent !== "object") return undefined;
	const value = (result.structuredContent as Record<string, unknown>).result;
	return typeof value === "string" ? value : undefined;
}

function extractContentResult(result: McpToolCallResult): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((part): part is McpTextContent => {
			if (!part || typeof part !== "object") return false;
			const record = part as Record<string, unknown>;
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

	const toolResult = result as McpToolCallResult;
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
	const normalizedParams = normalizeDeepWikiParams(params);
	const key = cacheKey(normalizedParams);
	const cached = responseCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cloneResponse(cached.response, true);
	}
	if (cached) responseCache.delete(key);

	const toolName = toolNameForAction(normalizedParams.action);
	const bodyJson = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: toolName,
			arguments: argumentsForParams(normalizedParams),
		},
	});

	// Timeout + bounded transient retry live in this extension's http.ts; non-retryable
	// statuses come back here for the domain-specific HTTP error below.
	const { response, text } = await fetchWithRetry(
		DEEPWIKI_MCP_URL,
		{
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
			},
			body: bodyJson,
		},
		{ timeoutMs: REQUEST_TIMEOUT_MS, retries: MAX_RETRIES, signal, label: "DeepWiki" },
	);

	if (!response.ok) {
		throw new Error(`DeepWiki HTTP ${response.status}: ${truncate(text)}`);
	}

	const envelope = parseEnvelope(text, response.headers.get("content-type"));
	if (envelope.error) {
		throw new Error(envelope.error.message ?? `DeepWiki JSON-RPC error ${envelope.error.code ?? "unknown"}`);
	}

	const resultText = extractToolText(envelope.result);
	const pageTitles = extractPageTitles(toolName, resultText);
	const result: DeepWikiResponse = {
		toolName,
		text: resultText,
		outputLength: resultText.length,
		...(pageTitles.length ? { pageTitles } : {}),
	};
	responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response: cloneResponse(result, false) });
	while (responseCache.size > MAX_CACHE_ENTRIES) {
		const oldest = responseCache.keys().next().value;
		if (oldest === undefined) break;
		responseCache.delete(oldest);
	}
	return result;
}
