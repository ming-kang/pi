/**
 * render.ts — TUI rendering for web_search tool (call, collapsed summary, expanded view).
 */

import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { getEngineLabel, WEB_SEARCH_LABEL } from "./constants.ts";
import { formatResultsMarkdown } from "./fusion.ts";
import type { WebSearchDetails, WebSearchHit } from "./types.ts";

/** Matches the bash/deepwiki progress display: sub-2s calls stay quiet. */
const ELAPSED_DISPLAY_THRESHOLD_MS = 2000;

function singleLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function firstText(result: AgentToolResult<WebSearchDetails>): string {
	for (const part of result.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

/** " · github.com, react.dev, +3" from the first-seen unique hit domains. */
function domainSummary(hits: WebSearchHit[]): string {
	const seen = new Set<string>();
	for (const hit of hits) {
		try {
			const host = new URL(hit.url).hostname.replace(/^www\./, "");
			if (host) seen.add(host);
		} catch {
			// ignore malformed URLs
		}
	}
	if (seen.size === 0) return "";
	const domains = [...seen];
	const shown = domains.slice(0, 2).join(", ");
	return domains.length > 2 ? ` · ${shown}, +${domains.length - 2}` : ` · ${shown}`;
}

export function renderWebSearchCall(args: unknown, theme: Theme): Component {
	let line = theme.fg("toolTitle", theme.bold(`${WEB_SEARCH_LABEL} `));
	const query = singleLine(
		args && typeof args === "object" && !Array.isArray(args) ? (args as { query?: unknown }).query : "",
	);
	line += theme.fg("accent", `"${truncateText(query, 60)}"`);
	return new Text(line, 0, 0);
}

function markdownBlock(text: string): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
	return container;
}

export function renderWebSearchResult(
	result: AgentToolResult<WebSearchDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	elapsedMs?: number,
): Component {
	const details = result.details;

	if (options.isPartial) {
		// The query stays on the call line above; no need to repeat it here.
		const engine = getEngineLabel(details?.engine);
		const label = engine ? `Searching via ${engine}...` : "Searching the web...";
		const suffix =
			elapsedMs !== undefined && elapsedMs >= ELAPSED_DISPLAY_THRESHOLD_MS
				? theme.fg("muted", ` (${Math.round(elapsedMs / 1000)}s)`)
				: "";
		return new Text(`${theme.fg("warning", label)}${suffix}`, 0, 0);
	}

	const text = firstText(result);
	const errorMessage = details?.errorMessage;

	if (isError || details?.status === "error") {
		const line = truncateText(errorMessage ?? (singleLine(text) || "Search request failed"), 160);
		return new Text(theme.fg("error", `failed · ${line}`), 0, 0);
	}

	if (details?.status === "disabled") {
		// Only reachable when the tool was force-enabled without credentials, or in
		// historical sessions: the session_start hook keeps it hidden otherwise.
		return new Text(
			theme.fg(
				"warning",
				"disabled · no MiniMax/DeepSeek key — /login minimax-cn or export MINIMAX_API_KEY / DEEPSEEK_API_KEY",
			),
			0,
			0,
		);
	}

	if (!options.expanded) {
		const hint = `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		if (!details) {
			// Legacy entries without details: show a bounded slice of the payload.
			const line = truncateText(singleLine(text), 100) || "done";
			return new Text(`${theme.fg("toolOutput", line)}${hint}`, 0, 0);
		}
		const hitCount = details.totalHits ?? details.hits.length;
		const engine = getEngineLabel(details.engine);
		const engineLabel = engine ? ` via ${engine}` : "";
		const duration = details.durationMs ? ` · ${(details.durationMs / 1000).toFixed(1)}s` : "";
		const countText = hitCount === 1 ? "1 result" : hitCount === 0 ? "no results" : `${hitCount} results`;
		const summary = theme.fg(
			"toolOutput",
			truncateText(`${countText}${engineLabel}${duration}${domainSummary(details.hits)}`, 100),
		);
		return new Text(`${summary}${hint}`, 0, 0);
	}

	// Expanded: structured sections from details, without the model-facing agent
	// directives; fall back to the raw payload for legacy entries without details.
	if (details) {
		const body = formatResultsMarkdown(details);
		if (body.trim()) return markdownBlock(body);
	}
	return markdownBlock(text);
}
