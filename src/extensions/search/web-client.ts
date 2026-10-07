/**
 * The web-search client: a JSON endpoint on the same Windsurf hosts, with no relation to the agent
 * protocol in client.ts beyond the shared failure taxonomy and app identity.
 */
import { clampInt } from "./clamp.ts";
import { WS_APP } from "./constants.ts";
import { classifyError, type HttpishError, SearchError } from "./errors.ts";

const WEB_SEARCH_HOSTS = ["https://server.codeium.com", "https://server.self-serve.windsurf.com"];
const WEB_SEARCH_PATH = "/exa.api_server_pb.ApiServerService/GetWebSearchResults";
const WEB_SEARCH_UA = "windsurf/1.9600.41";
const WEB_SEARCH_VERSION = WEB_SEARCH_UA.split("/")[1]!;

export interface WebSearchItem {
	url: string;
	title: string;
	snippet: string;
	publishedAt?: string;
}

export interface WebSearchResponse {
	items: WebSearchItem[];
	truncated: boolean;
}

/** First non-blank string among `keys`, trimmed and capped. */
function firstString(row: Record<string, unknown>, keys: string[], cap: number): string {
	for (const key of keys) {
		const v = row[key];
		if (typeof v === "string" && v.trim()) return v.trim().slice(0, cap);
	}
	return "";
}

function isSafeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

async function webSearchOnce(
	apiKey: string,
	query: string,
	limit: number,
	signal: AbortSignal | undefined,
	host: string,
	fetcher: typeof fetch,
): Promise<WebSearchResponse> {
	let resp: Response;
	try {
		resp = await fetcher(`${host}${WEB_SEARCH_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
				Accept: "application/json",
				"User-Agent": WEB_SEARCH_UA,
			},
			body: JSON.stringify({
				metadata: {
					apiKey,
					ideName: WS_APP,
					ideVersion: WEB_SEARCH_VERSION,
					extensionName: WS_APP,
					extensionVersion: WEB_SEARCH_VERSION,
					locale: "en",
				},
				query,
				limit,
			}),
			redirect: "error",
			signal: signal ?? AbortSignal.timeout(20000),
		});
	} catch (e) {
		throw classifyError(e as HttpishError);
	}
	if (!resp.ok) {
		const err: HttpishError = new Error(`HTTP ${resp.status}`);
		err.status = resp.status;
		throw classifyError(err);
	}
	const raw = await resp.text();
	const redacted = raw.split(apiKey).join("[redacted]"); // defense in depth: the key must never ride along
	let payload: unknown;
	try {
		payload = JSON.parse(redacted);
	} catch {
		throw new SearchError("Invalid JSON from web search endpoint", "SERVER_ERROR");
	}
	const results = (payload as { results?: unknown })?.results;
	if (!Array.isArray(results)) {
		throw new SearchError("Web search endpoint returned no results array", "SERVER_ERROR");
	}
	const items: WebSearchItem[] = [];
	let valid = 0;
	for (const rawItem of results) {
		if (typeof rawItem !== "object" || rawItem === null) continue;
		const row = rawItem as Record<string, unknown>;
		const url = firstString(row, ["url", "sourceUrl", "webUrl", "link"], 4096);
		if (!url || !isSafeUrl(url)) continue;
		valid++;
		if (items.length >= limit) continue;
		const published = firstString(row, ["publishedAt", "published_at", "date", "time"], 40);
		items.push({
			url,
			title: firstString(row, ["title", "name", "webTitle"], 512) || url,
			snippet: firstString(row, ["snippet", "summary", "text", "content"], 4096),
			...(published ? { publishedAt: published.slice(0, 10) } : {}),
		});
	}
	return { items, truncated: valid > items.length };
}

export async function fetchWebSearch(
	apiKey: string,
	query: string,
	maxResults: unknown,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<WebSearchResponse> {
	const limit = clampInt(maxResults, 5, 1, 10);
	let sawAuthRejection = false;
	for (const host of WEB_SEARCH_HOSTS) {
		try {
			return await webSearchOnce(apiKey, query, limit, signal, host, fetcher);
		} catch (e) {
			const fe = classifyError(e as HttpishError);
			if (fe.code === "AUTH_ERROR") {
				sawAuthRejection = true; // one rejected host does not prove the key is dead
				continue;
			}
			throw fe;
		}
	}
	if (sawAuthRejection) {
		throw new SearchError("Devin rejected the key (401/403)", "AUTH_ERROR");
	}
	throw new SearchError("Web search failed on all hosts", "NETWORK_ERROR");
}
