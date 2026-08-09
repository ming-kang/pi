/**
 * TUI rendering for the deepwiki tool (collapse / expand).
 *
 * Pi's fallback renderer dumps full `content` text and ignores `expanded`; this
 * extension returns large wiki payloads, so a private renderer stays local here.
 */
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

import { extractContentPages, extractStructureSections } from "./client.ts";
import { DEEPWIKI_LABEL } from "./constants.ts";
import type { DeepWikiDetails } from "./execute.ts";
import type { DeepWikiParams } from "./schema.ts";

function truncateText(text: string, maxLength: number, options?: { word?: boolean }): string {
	if (text.length <= maxLength) return text;
	if (options?.word) {
		const prefix = text.slice(0, maxLength - 3);
		const lastSpace = prefix.lastIndexOf(" ");
		if (lastSpace >= 40) return `${prefix.slice(0, lastSpace)}...`;
	}
	return `${text.slice(0, maxLength - 3)}...`;
}

function singleLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function firstText(result: AgentToolResult<DeepWikiDetails>): string {
	for (const part of result.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

function firstContentLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "DeepWiki response"
	);
}

function formatPageList(pages: string[], maxItems = 4): string {
	const shown = pages.slice(0, maxItems).map(singleLine).join(", ");
	return pages.length > maxItems ? `${shown}...` : shown;
}

function pageTitlesFromResult(text: string, details: DeepWikiDetails | undefined): string[] {
	if (Array.isArray(details?.pageTitles)) {
		const titles = details.pageTitles.filter((title) => typeof title === "string");
		if (titles.length) return titles;
	}
	if (Array.isArray(details?.sectionTitles)) {
		const titles = details.sectionTitles.filter((title) => typeof title === "string");
		if (titles.length) return titles;
	}
	const fromContent = extractContentPages(text);
	if (fromContent.length) return fromContent;
	return extractStructureSections(text);
}

function summarizeStructure(text: string, details: DeepWikiDetails | undefined): string {
	const pages = pageTitlesFromResult(text, details);
	if (pages.length === 0) return truncateText(firstContentLine(text), 120);
	const count = details?.pageCount ?? pages.length;
	return `${count} pages · ${formatPageList(pages)}`;
}

function summarizeContents(text: string, details: DeepWikiDetails | undefined): string {
	if (typeof details?.requestedPage === "string" && details.requestedPage.trim()) {
		const position =
			details.pageIndex !== undefined && details.pageCount ? `${details.pageIndex}/${details.pageCount} · ` : "";
		const cut = details.truncatedChars ? " (truncated)" : "";
		return `Page ${position}${singleLine(details.requestedPage)}${cut}`;
	}
	const pages = pageTitlesFromResult(text, details);
	if (details?.shownPages !== undefined) {
		const total = details.pageCount ?? pages.length;
		const pagesPart = total > 0 ? `${details.shownPages}/${total} pages` : "partial";
		return `Wiki · ${pagesPart} shown (truncated)`;
	}
	if (pages.length === 0) return "Wiki loaded";
	return `Wiki · ${details?.pageCount ?? pages.length} pages`;
}

function stripDeepWikiTail(text: string): string {
	const tailIndex = text.search(/\n(?:#+\s*)?(?:Wiki pages you might want to explore|View this search)/i);
	if (tailIndex < 0) return text;
	return text.slice(0, tailIndex);
}

function summarizeQuestion(text: string): string {
	const cleaned = stripDeepWikiTail(text)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "Answer ready";
	const sentenceMatch = cleaned.match(/^.{40,}?[.!?](?=\s|$)/);
	return truncateText(sentenceMatch?.[0] ?? cleaned, 140, { word: true });
}

function summarizeCollapsed(text: string, details: DeepWikiDetails | undefined): string {
	let summary: string;
	if (details?.action === "structure") summary = summarizeStructure(text, details);
	else if (details?.action === "contents") summary = summarizeContents(text, details);
	else if (details?.action === "question") summary = summarizeQuestion(text);
	else summary = truncateText(firstContentLine(text), 120);
	return truncateText(singleLine(summary), 180, { word: true });
}

function repoLabel(repoName: DeepWikiParams["repoName"] | undefined): string {
	if (Array.isArray(repoName)) {
		if (repoName.length === 0) return "repo";
		if (repoName.length === 1) return repoName[0];
		return `${repoName.length} repos: ${repoName.slice(0, 2).join(", ")}${repoName.length > 2 ? "..." : ""}`;
	}
	return repoName ?? "repo";
}

/** renderCall sees raw tool args; normalize JSON-array strings for display. */
function repoLabelForCall(repoName: unknown): string {
	if (Array.isArray(repoName)) return repoLabel(repoName as DeepWikiParams["repoName"]);
	if (typeof repoName === "string") {
		const trimmed = repoName.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed)) return repoLabel(parsed as string[]);
			} catch {
				/* fall through */
			}
		}
		return repoLabel(repoName);
	}
	return repoLabel(undefined);
}

export function renderDeepWikiCall(args: DeepWikiParams, theme: Theme): Component {
	let line = theme.fg("toolTitle", theme.bold(`${DEEPWIKI_LABEL} `));
	line += theme.fg("muted", args.action);
	line += ` ${theme.fg("accent", repoLabelForCall(args.repoName))}`;
	if (args.action === "question" && args.question) {
		line += ` ${theme.fg("dim", truncateText(singleLine(args.question), 64))}`;
	} else if (args.action === "contents" && args.page !== undefined) {
		line += ` ${theme.fg("dim", truncateText(singleLine(String(args.page)), 40))}`;
	}
	return new Text(line, 0, 0);
}

function markdownBlock(text: string): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
	return container;
}

export function renderDeepWikiResult(
	result: AgentToolResult<DeepWikiDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	elapsedMs?: number,
): Component {
	if (options.isPartial) {
		const repo = typeof result.details?.repoName === "string" ? singleLine(result.details.repoName) : "";
		const label = repo ? `Querying ${repo}...` : "Querying...";
		// Slow network calls earn a visible elapsed count; sub-2s stays quiet.
		const suffix =
			elapsedMs !== undefined && elapsedMs >= 2000 ? theme.fg("muted", ` (${Math.round(elapsedMs / 1000)}s)`) : "";
		return new Text(`${theme.fg("warning", label)}${suffix}`, 0, 0);
	}

	const text = firstText(result);
	const errorMessage = typeof result.details?.errorMessage === "string" ? result.details.errorMessage : undefined;
	if (isError || errorMessage) {
		const line = truncateText(errorMessage ?? firstContentLine(text), 200);
		return new Text(theme.fg("error", `failed · ${line}`), 0, 0);
	}

	if (!options.expanded) {
		const summary = theme.fg("toolOutput", summarizeCollapsed(text, result.details));
		const hint = `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return new Text(`${summary}${hint}`, 0, 0);
	}

	return markdownBlock(text);
}
