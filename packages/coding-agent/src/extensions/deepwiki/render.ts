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
	const shown = pages.slice(0, maxItems).join(", ");
	return pages.length > maxItems ? `${shown}...` : shown;
}

function pageTitlesFromResult(text: string, details: DeepWikiDetails | undefined): string[] {
	if (details?.pageTitles?.length) return details.pageTitles;
	if (details?.sectionTitles?.length) return details.sectionTitles;
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
	if (details?.requestedPage) {
		const position =
			details.pageIndex !== undefined && details.pageCount ? `${details.pageIndex}/${details.pageCount} · ` : "";
		const cut = details.truncatedChars ? " (truncated)" : "";
		return `Page ${position}${details.requestedPage}${cut}`;
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
	if (details?.action === "structure") return summarizeStructure(text, details);
	if (details?.action === "contents") return summarizeContents(text, details);
	if (details?.action === "question") return summarizeQuestion(text);
	return truncateText(firstContentLine(text), 120);
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
		line += ` ${theme.fg("dim", truncateText(args.question, 64))}`;
	} else if (args.action === "contents" && args.page !== undefined) {
		line += ` ${theme.fg("dim", truncateText(String(args.page), 40))}`;
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
): Component {
	if (options.isPartial) {
		const repo = result.details?.repoName;
		const label = repo ? `Querying ${repo}...` : "Querying...";
		return new Text(theme.fg("warning", label), 0, 0);
	}

	const text = firstText(result);
	if (isError || result.details?.errorMessage) {
		const msg = result.details?.errorMessage ?? firstContentLine(text);
		const line = truncateText(msg, 200);
		return new Text(theme.fg("error", `failed · ${line}`), 0, 0);
	}

	if (!options.expanded) {
		const summary = theme.fg("accent", summarizeCollapsed(text, result.details));
		const hint = `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return new Text(`${summary}\n${hint}`, 0, 0);
	}

	return markdownBlock(text);
}
