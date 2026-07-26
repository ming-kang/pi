import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";

/** Render a full-width rule using a semantic theme color. */
export function ruleBorder(theme: Theme, width: number, color: ThemeColor = "accent"): string {
	return theme.fg(color, "─".repeat(Math.max(0, width)));
}

/** Wrap ANSI text with a hanging prefix and append it to the output lines. */
export function wrapWithPrefix(prefix: string, text: string, width: number, outputLines: string[]): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		for (const line of wrapTextWithAnsi(prefix + text, width)) outputLines.push(line);
		return;
	}

	const wrappedLines = wrapTextWithAnsi(text, width - prefixWidth);
	const continuationPrefix = " ".repeat(prefixWidth);
	for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex++) {
		outputLines.push(`${lineIndex === 0 ? prefix : continuationPrefix}${wrappedLines[lineIndex]}`);
	}
}
