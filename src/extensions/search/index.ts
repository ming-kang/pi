/**
 * Devin Search: `code_search` and `web_search`, both authenticated by one Devin sign-in.
 *
 * Both tools stay registered so `/tools` and old transcripts know them; a session without a
 * credential starts with them inactive, and signing in or out through `/search` toggles them.
 */
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { codeSearch, formatLocations } from "./code-search.ts";
import { registerSearchCommand, syncTools } from "./command.ts";
import { getCredential } from "./credential.ts";
import { DevinAuthError, type WebResult, webSearch } from "./devin.ts";
import {
	type CodeSearchDetails,
	renderCodeSearchCall,
	renderCodeSearchResult,
	renderWebSearchCall,
	renderWebSearchResult,
	type WebSearchDetails,
} from "./render.ts";
import { isInside } from "./workspace.ts";

const WEB_EXCERPT_MAX_CHARS = 1500;

const CodeSearchParams = Type.Object({
	query: Type.String({
		description:
			"Natural-language description of the behavior, flow, error, or concept to locate, in concise English. Keep identifiers, API names, and error text verbatim. Not for a bare symbol, filename, or literal.",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Subdirectory to search, relative to or inside the working directory. Defaults to the working directory.",
		}),
	),
});

const WebSearchParams = Type.Object({
	query: Type.String({
		description: "Web search query. Be specific: product names, versions, exact error text. English matches best.",
	}),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Results to return (default 5)." })),
});

const SIGN_IN_HINT = "Ask the user to run /search to sign in to Devin.";

/** Run a Devin call with the current credential; credential failures tell the model what fixes them. */
async function withDevin<T>(run: (apiKey: string) => Promise<T>): Promise<T> {
	const credential = getCredential();
	if (!credential) throw new Error(`Devin Search is not signed in. ${SIGN_IN_HINT}`);
	try {
		return await run(credential.apiKey);
	} catch (error) {
		throw error instanceof DevinAuthError ? new Error(`${error.message} ${SIGN_IN_HINT}`) : error;
	}
}

export function formatWebResults(query: string, results: WebResult[]): string {
	if (!results.length) return `No web results for "${query}".`;
	const blocks = results.map((r, i) => {
		const lines = [`${i + 1}. ${r.title ?? r.url}`, `   ${r.url}`];
		if (r.summary) {
			const excerpt = r.summary.replace(/\n\s*\n+/g, "\n").trim();
			lines.push(excerpt.length > WEB_EXCERPT_MAX_CHARS ? `${excerpt.slice(0, WEB_EXCERPT_MAX_CHARS)}…` : excerpt);
		}
		return lines.join("\n");
	});
	return truncateHead(`Web results for "${query}":\n\n${blocks.join("\n\n")}`).content;
}

export default function search(pi: ExtensionAPI): void {
	pi.registerTool<typeof CodeSearchParams, CodeSearchDetails>({
		name: "code_search",
		label: "Code Search",
		description:
			"Find where behavior lives in the local repository from a description of it. " +
			"Returns candidate files with line ranges.",
		promptSnippet: "Find code by describing its behavior",
		promptGuidelines: [
			"Use `code_search` when you cannot name the file or symbol you need; use `read`, `grep`, or `find` when you can.",
			"Read the returned ranges before editing; the locations are candidates, not answers.",
		],
		parameters: CodeSearchParams,
		renderCall: renderCodeSearchCall,
		renderResult: renderCodeSearchResult,

		async execute(_toolCallId, params: Static<typeof CodeSearchParams>, signal, onUpdate, ctx) {
			const root = resolve(ctx.cwd, params.path ?? ".");
			if (!isInside(ctx.cwd, root)) throw new Error(`path must be inside the working directory (${ctx.cwd}).`);
			const locations = await withDevin((apiKey) =>
				codeSearch({
					apiKey,
					query: params.query.trim(),
					root,
					cwd: ctx.cwd,
					signal,
					onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { locations: [] } }),
				}),
			);
			return { content: [{ type: "text", text: formatLocations(locations) }], details: { locations } };
		},
	});

	// Pi's system prompt carries no date, so models otherwise search with their training year.
	const currentMonth = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
	pi.registerTool<typeof WebSearchParams, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web for current information. Returns titles, URLs, and the page excerpts that match the query.",
		promptSnippet: "Search the live web for current information",
		promptGuidelines: [
			"Use `web_search` for information beyond your knowledge cutoff.",
			`It is ${currentMonth}; put this year in \`web_search\` queries for recent releases, versions, or events, not the year your training data suggests.`,
			"When an answer relies on `web_search` results, cite each result you used as a markdown link: [Title](URL).",
		],
		parameters: WebSearchParams,
		renderCall: renderWebSearchCall,
		renderResult: renderWebSearchResult,

		async execute(_toolCallId, params: Static<typeof WebSearchParams>, signal) {
			const query = params.query.trim();
			const results = await withDevin((apiKey) => webSearch(apiKey, query, params.max_results ?? 5, signal));
			return {
				content: [{ type: "text", text: formatWebResults(query, results) }],
				details: { results: results.map(({ url, title }) => ({ url, title })) },
			};
		},
	});

	registerSearchCommand(pi);
	pi.on("session_start", async () => syncTools(pi));
}
