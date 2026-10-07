import { fetchWebSearch, type WebSearchItem } from "./web-client.ts";

export interface WebSearchParams {
	query?: string;
	max_results?: number;
}

export interface WebSearchDetails {
	status: "success" | "error";
	query: string;
	sources: WebSearchItem[];
	truncated: boolean;
	errorMessage?: string;
}

export interface WebSearchOutput {
	text: string;
	details: WebSearchDetails;
}

const MAX_QUERY_CHARS = 8192;

function formatText(details: WebSearchDetails): string {
	if (details.status === "error") return `Error: ${details.errorMessage ?? "web search failed"}`;
	const lines: string[] = [`Web search: "${details.query}" — ${details.sources.length} result(s) via Devin`, ""];
	for (const [i, item] of details.sources.entries()) {
		lines.push(`${i + 1}. ${item.title}`);
		lines.push(`   ${item.url}${item.publishedAt ? `  [${item.publishedAt}]` : ""}`);
		if (item.snippet) lines.push(`   ${item.snippet.replace(/\s+/g, " ").trim()}`);
	}
	if (details.truncated) {
		lines.push("", "[truncated] more results exist; narrow the query or read the top URLs for detail.");
	}
	return lines.join("\n");
}

export async function runWebSearch(
	params: WebSearchParams,
	apiKey: string,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
): Promise<WebSearchOutput> {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	const details = (partial: Partial<WebSearchDetails>): WebSearchDetails => ({
		status: "success",
		query,
		sources: [],
		truncated: false,
		...partial,
	});
	if (!query)
		return {
			text: "Error: query is required.",
			details: details({ status: "error", errorMessage: "query is required" }),
		};
	if (query.length > MAX_QUERY_CHARS) {
		return {
			text: `Error: query is too long (${query.length} > ${MAX_QUERY_CHARS}).`,
			details: details({ status: "error", errorMessage: "query too long" }),
		};
	}

	onProgress?.("Searching the web via Devin…");
	try {
		const { items, truncated } = await fetchWebSearch(apiKey, query, params.max_results, signal);
		const full = details({ sources: items, truncated });
		return { text: formatText(full), details: full };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const fe = e as { code?: string };
		const errorMessage =
			fe.code === "AUTH_ERROR"
				? "Devin rejected the key. Run /search to sign in again."
				: fe.code === "RATE_LIMITED"
					? "Devin rate-limited the web search. Wait a moment and retry."
					: message;
		return { text: `Error: ${errorMessage}`, details: details({ status: "error", errorMessage }) };
	}
}
