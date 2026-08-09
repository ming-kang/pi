import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { collapsedLinesHint } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

export const TOOL_CHROME_WIDTH = 2;
const FALLBACK_ARGS_WIDTH = 120;
const FALLBACK_RESULT_LINES = 10;

export function formatElapsed(ms: number): string {
	const roundedTenths = Math.round(ms / 100) / 10;
	if (roundedTenths < 60) return `${roundedTenths.toFixed(1)}s`;
	const roundedSeconds = Math.round(ms / 1000);
	return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
}

/** Status dot / result rail prefix wrapper for a tool call or result slot. */
export class ToolChromeComponent implements Component {
	private component: Component;
	private prefix: string;
	private continuationPrefix: string;
	private blankLinePrefix: string;
	private trimLeadingBlankLines: boolean;

	constructor(
		component: Component,
		prefix: string,
		options: { trimLeadingBlankLines?: boolean; continuationPrefix?: string; blankLinePrefix?: string } = {},
	) {
		this.component = component;
		this.prefix = prefix;
		this.continuationPrefix = options.continuationPrefix ?? "  ";
		this.blankLinePrefix = options.blankLinePrefix ?? "";
		this.trimLeadingBlankLines = options.trimLeadingBlankLines ?? false;
	}

	render(width: number): string[] {
		const renderedLines = this.component.render(Math.max(1, width - TOOL_CHROME_WIDTH));
		let start = 0;
		if (this.trimLeadingBlankLines) {
			while (renderedLines[start] === "") start++;
		}
		const lines = renderedLines.slice(start);
		if (lines.length === 0) return [];
		return lines.map((line, index) => {
			if (index === 0) return `${this.prefix}${line}`;
			return line ? `${this.continuationPrefix}${line}` : this.blankLinePrefix;
		});
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

/** Bounded text fallback for tools without a result renderer. */
export class FallbackResultComponent implements Component {
	private output: string;
	private expanded: boolean;

	constructor(output: string, expanded: boolean) {
		this.output = output;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const styledOutput = theme.fg("toolOutput", this.output);
		if (this.expanded) return new Text(styledOutput, 0, 0).render(width);

		const preview = truncateToVisualLines(styledOutput, FALLBACK_RESULT_LINES, width);
		if (preview.skippedCount <= 0) return preview.visualLines;
		const hint = collapsedLinesHint(theme, preview.skippedCount, "earlier");
		return [truncateToWidth(hint, width, "…"), ...preview.visualLines];
	}

	invalidate(): void {}
}

export function formatFallbackArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	const summary = entries
		.map(([key, value]) => {
			try {
				return `${key}=${JSON.stringify(value) ?? String(value)}`;
			} catch {
				return `${key}=${String(value)}`;
			}
		})
		.join(" ")
		.replace(/\s+/g, " ");
	return truncateToWidth(summary, FALLBACK_ARGS_WIDTH, "...");
}
