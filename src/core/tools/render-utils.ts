import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ThenRunDetails } from "./then-run.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

/** Extract the fused then_run command from raw tool call args, if present. */
export function thenRunCommandOf(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const thenRun = (args as { then_run?: unknown }).then_run;
	if (!thenRun || typeof thenRun !== "object") return undefined;
	const command = (thenRun as { command?: unknown }).command;
	return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** Bound long text for display: keep the tail, hint at hidden earlier lines. */
export function boundDisplayTail(text: string, theme: Theme, expanded: boolean, maxLines = 10): string {
	const lines = normalizeDisplayText(text).split("\n");
	if (expanded || lines.length <= maxLines) return lines.join("\n");
	const shown = lines.slice(-maxLines);
	const hidden = lines.length - shown.length;
	return `${shown.join("\n")}\n${collapsedLinesHint(theme, hidden, "earlier", { total: lines.length })}`;
}

/**
 * Display section for a fused then_run command: dimmed `$ cmd` plus the bounded
 * output tail. Skipped runs render their note as-is; failed runs throw from the
 * tool and render through the error path instead.
 */
export function formatThenRunSection(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: Theme,
	expanded: boolean,
): string | undefined {
	const details = (result.details as { thenRun?: ThenRunDetails } | null | undefined)?.thenRun;
	if (!details) return undefined;
	const body = result.content
		.slice(1)
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
	if (details.status === "skipped") {
		return theme.fg("muted", body);
	}
	const prefix = `[then_run] $ ${details.command}\n`;
	const output = body.startsWith(prefix) ? body.slice(prefix.length) : body;
	let text = theme.fg("muted", `$ ${details.command}`);
	if (output) {
		text += `\n${theme.fg("toolOutput", boundDisplayTail(replaceTabs(output), theme, expanded))}`;
	}
	return text;
}

/**
 * Shared collapsed-output hint: `… (N earlier/more lines, ctrl+o to expand)`.
 * `direction` is "earlier" when the preview keeps the tail, "more" when it keeps the head.
 */
export function collapsedLinesHint(
	theme: Theme,
	hidden: number,
	direction: "earlier" | "more",
	options?: { total?: number },
): string {
	const totalSuffix = options?.total !== undefined ? `, ${options.total} total` : "";
	const noun = hidden === 1 ? "line" : "lines";
	return (
		theme.fg("muted", `… (${hidden} ${direction} ${noun}${totalSuffix},`) +
		` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
	);
}
