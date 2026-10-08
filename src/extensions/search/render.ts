/**
 * Rows for code_search and web_search, in the shape of the built-in explore tools: a one-line
 * header that carries progress and the result count, and a body only when expanded (or failed).
 * The model-facing text is untouched; these read `details`.
 */
import { type Component, Container, hyperlink, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { CodeLocation } from "./code-search.ts";
import type { WebResult } from "./devin.ts";

export interface CodeSearchDetails {
	locations: CodeLocation[];
}

export interface WebSearchDetails {
	results: WebResult[];
}

/** Columns beyond which a path or title stops pushing the second column right. */
const MAX_FIRST_COLUMN = 56;

function textOf(result: AgentToolResult<unknown> | undefined): string {
	const block = result?.content.find((c) => c.type === "text");
	return block && "text" in block ? block.text.trim() : "";
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `● name "query"<scope> · <status>`, where status is live progress, then the result count. */
function header(
	theme: Theme,
	name: string,
	query: string | undefined,
	scope: string,
	context: ToolRenderContext,
	summary: () => string,
): Component {
	let line = `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", `"${query ?? ""}"`)}`;
	if (scope) line += theme.fg("toolOutput", scope);
	const status = !context.result || context.isError ? "" : context.isPartial ? textOf(context.result) : summary();
	if (status) line += theme.fg("muted", ` · ${status}`);
	return new Text(line, 0, 0);
}

/** Two aligned columns; the first is padded to the widest entry, up to MAX_FIRST_COLUMN. */
function columns(rows: Array<{ first: string; second: string }>): Component {
	const width = Math.min(MAX_FIRST_COLUMN, Math.max(...rows.map((r) => visibleWidth(r.first))));
	const lines = rows.map(({ first, second }) => {
		const cell = visibleWidth(first) > width ? truncateToWidth(first, width, "…") : first;
		return `${cell}${" ".repeat(Math.max(0, width - visibleWidth(cell)))}   ${second}`;
	});
	return new Text(lines.join("\n"), 0, 0);
}

/** Collapsed and still-running rows show nothing below the header; a failure always shows its message. */
function body(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
	expanded: () => Component,
): Component {
	if (context.isError) return new Text(theme.fg("error", textOf(result).split("\n")[0] ?? ""), 0, 0);
	if (!options.expanded || options.isPartial) return new Container();
	return expanded();
}

export function renderCodeSearchCall(
	args: { query?: string; path?: string },
	theme: Theme,
	context: ToolRenderContext<unknown, unknown, CodeSearchDetails>,
): Component {
	const scope = args.path && args.path !== "." ? ` in ${args.path.replace(/\\/g, "/")}` : "";
	return header(theme, "code_search", args.query, scope, context, () => {
		const n = context.result?.details?.locations.length ?? 0;
		return n ? plural(n, "file") : "nothing found";
	});
}

export function renderCodeSearchResult(
	result: AgentToolResult<CodeSearchDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, { path?: string }, CodeSearchDetails>,
): Component {
	return body(result, options, theme, context, () => {
		const locations = result.details?.locations ?? [];
		if (!locations.length) return new Text(theme.fg("muted", "No relevant code found."), 0, 0);
		// Paths are relative to the session directory; show them relative to the searched path.
		const scope = context.args.path?.replace(/\\/g, "/").replace(/^\.\/?|\/+$/g, "");
		return columns(
			locations.map(({ path, ranges }) => {
				const shown = scope && path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : path;
				const slash = shown.lastIndexOf("/");
				return {
					first: theme.fg("muted", shown.slice(0, slash + 1)) + theme.fg("toolOutput", shown.slice(slash + 1)),
					second: theme.fg("accent", ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(" · ")),
				};
			}),
		);
	});
}

export function renderWebSearchCall(
	args: { query?: string },
	theme: Theme,
	context: ToolRenderContext<unknown, unknown, WebSearchDetails>,
): Component {
	return header(theme, "web_search", args.query, "", context, () => {
		const n = context.result?.details?.results.length ?? 0;
		return n ? plural(n, "result") : "no results";
	});
}

export function renderWebSearchResult(
	result: AgentToolResult<WebSearchDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<unknown, unknown, WebSearchDetails>,
): Component {
	return body(result, options, theme, context, () => {
		const results = result.details?.results ?? [];
		if (!results.length) return new Text(theme.fg("muted", "No results."), 0, 0);
		return columns(
			results.map(({ url, title }) => {
				const host = new URL(url).hostname.replace(/^www\./, "");
				const label = title ?? url;
				const cell = visibleWidth(label) > MAX_FIRST_COLUMN ? truncateToWidth(label, MAX_FIRST_COLUMN, "…") : label;
				return { first: hyperlink(theme.fg("toolOutput", cell), url), second: theme.fg("muted", host) };
			}),
		);
	});
}
