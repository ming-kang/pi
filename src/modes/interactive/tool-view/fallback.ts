/** Generic call and result presentation for a tool that supplies no renderer. */

import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatToolCallWithArgs } from "../../../core/tools/render-utils.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { truncateToVisualLines } from "../components/visual-truncate.ts";
import { theme } from "../theme/theme.ts";
import { toolStyle } from "./style.ts";

/** One-line `key=value` summary of a call's arguments, bounded by `toolStyle.fallbackArgsWidth`. */
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
	return truncateToWidth(summary, toolStyle.fallbackArgsWidth, "...");
}

export function createCallFallback(toolName: string, args: unknown, expanded = false): Component {
	if (expanded) return new Text(formatToolCallWithArgs(toolName, args, theme, true), 0, 0);
	const summary = formatFallbackArgs(args);
	const suffix = summary ? theme.fg("dim", `(${summary})`) : "";
	return new Text(`${theme.fg("toolTitle", theme.bold(toolName))}${suffix}`, 0, 0);
}

/** The last `toolStyle.collapsed.fallbackLines` lines of the output, or all of it when expanded. */
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

		const preview = truncateToVisualLines(styledOutput, toolStyle.collapsed.fallbackLines, width);
		if (preview.skippedCount <= 0) return preview.visualLines;
		const noun = preview.skippedCount === 1 ? "line" : "lines";
		const hint =
			theme.fg("muted", `... (${preview.skippedCount} earlier ${noun},`) +
			` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		return [truncateToWidth(hint, width, "..."), ...preview.visualLines];
	}

	invalidate(): void {}
}
