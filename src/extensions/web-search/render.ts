/**
 * render.ts — TUI rendering for web_search tool (call, collapsed summary, expanded view).
 */

import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { getEngineLabel, WEB_SEARCH_LABEL } from "./constants.ts";
import type { WebSearchParams } from "./schema.ts";
import type { WebSearchDetails } from "./types.ts";

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

export function renderWebSearchCall(args: WebSearchParams, theme: Theme): Component {
	let line = theme.fg("toolTitle", theme.bold(`${WEB_SEARCH_LABEL} `));
	const query = singleLine(args.query || "");
	line += theme.fg("accent", `"${truncateText(query, 60)}"`);

	if (args.allowed_domains && args.allowed_domains.length > 0) {
		line += ` ${theme.fg("muted", `[sites: ${args.allowed_domains.join(", ")}]`)}`;
	} else if (args.blocked_domains && args.blocked_domains.length > 0) {
		line += ` ${theme.fg("muted", `[-sites: ${args.blocked_domains.join(", ")}]`)}`;
	}

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
		const query = details?.query ? singleLine(details.query) : "";
		const engine = getEngineLabel(details?.engine);
		const enginePart = engine ? ` [${engine}]` : "";
		const label = query ? `Searching${enginePart}: "${truncateText(query, 40)}"...` : "Searching web...";
		const suffix =
			elapsedMs !== undefined && elapsedMs >= 1500 ? theme.fg("muted", ` (${Math.round(elapsedMs / 1000)}s)`) : "";
		return new Text(`${theme.fg("warning", label)}${suffix}`, 0, 0);
	}

	const text = firstText(result);
	const errorMessage = details?.errorMessage;

	if (isError || details?.status === "error") {
		const line = truncateText(errorMessage ?? (singleLine(text) || "Search request failed"), 160);
		return new Text(theme.fg("error", `failed · ${line}`), 0, 0);
	}

	if (details?.status === "disabled") {
		return new Text(theme.fg("warning", "disabled · No MiniMax or DeepSeek API Key found in auth.json"), 0, 0);
	}

	if (!options.expanded) {
		const hitCount = details?.totalHits ?? details?.hits?.length ?? 0;
		const engine = getEngineLabel(details?.engine);
		const engineLabel = engine ? ` via ${engine}` : "";
		const duration = details?.durationMs ? ` · ${(details.durationMs / 1000).toFixed(1)}s` : "";

		const countText = hitCount === 1 ? "1 result" : `${hitCount} results`;
		const summary = theme.fg("toolOutput", `${countText}${engineLabel}${duration}`);
		const hint = `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return new Text(`${summary}${hint}`, 0, 0);
	}

	return markdownBlock(text);
}
