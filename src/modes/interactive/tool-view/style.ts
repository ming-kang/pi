/**
 * The look of a tool block, defined in one place.
 *
 * A tool block is a marker line plus a rail:
 *
 *   ● grep /useState/ in src      marker: the tool's state
 *   │ src/a.tsx:12: useState()    rail: everything that belongs to the same tool
 *
 * Single-line tool blocks sit directly under each other; multiline blocks and text keep a blank line. Change the look
 * by editing `toolStyle` or `FramedComponent`; nothing else in the transcript hard-codes it.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

export type ToolStatus = "pending" | "success" | "error";

export interface ToolStyle {
	marker: { glyph: string; color: Record<ToolStatus, ThemeColor> };
	rail: { glyph: string; color: ThemeColor };
	/** Blank lines above a tool block, by what precedes it. */
	gap: { afterTool: number; afterMultilineTool: number; afterOther: number };
	collapsed: {
		/**
		 * Tools whose successful result stays hidden until expanded. A failure always shows. The shell
		 * folds only the built-in result renderer, matched by identity, so list only tools whose
		 * renderers are module-level constants: `bash` and `powershell` build fresh ones and never match.
		 */
		headerOnly: ReadonlySet<string>;
		/** Output tail kept for a tool that has no result renderer. */
		fallbackLines: number;
	};
	/** Width budget for the argument summary a tool without a call renderer shows. */
	fallbackArgsWidth: number;
}

export const toolStyle: ToolStyle = {
	marker: { glyph: "●", color: { pending: "warning", success: "success", error: "error" } },
	rail: { glyph: "│", color: "dim" },
	gap: { afterTool: 0, afterMultilineTool: 1, afterOther: 1 },
	collapsed: { headerOnly: new Set(["read", "grep", "find", "ls"]), fallbackLines: 10 },
	fallbackArgsWidth: 120,
};

export function toolStatus(state: { isPartial: boolean; isError: boolean }): ToolStatus {
	return state.isPartial ? "pending" : state.isError ? "error" : "success";
}

export function toolMarkerColor(status: ToolStatus): ThemeColor {
	return toolStyle.marker.color[status];
}

function cellWidth(): number {
	return Math.max(visibleWidth(toolStyle.marker.glyph), visibleWidth(toolStyle.rail.glyph));
}

/** Columns the marker or rail takes, including the space before the content. */
export function gutterWidth(): number {
	return cellWidth() + 1;
}

function gutterCell(glyph: string, color: ThemeColor): string {
	return `${theme.fg(color, glyph)}${" ".repeat(cellWidth() - visibleWidth(glyph) + 1)}`;
}

/** A line that shows nothing: empty, or only spaces once styling is removed (Text pads its lines). */
function isBlankLine(line: string): boolean {
	return line === "" || stripAnsi(line).trim() === "";
}

function dropLeadingBlankLines(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start]!)) start++;
	return lines.slice(start);
}

/**
 * Hangs a component's lines off the marker (header) or the rail (body). A header's first line
 * carries the marker; every other line, and every body line, carries the rail, and a blank line
 * keeps a bare rail so the block stays connected.
 */
export class FramedComponent implements Component {
	private component: Component;
	private kind: "header" | "body";
	private markerColor: () => ThemeColor;

	constructor(component: Component, kind: "header" | "body", markerColor: () => ThemeColor) {
		this.component = component;
		this.kind = kind;
		this.markerColor = markerColor;
	}

	render(width: number): string[] {
		const rendered = this.component.render(Math.max(1, width - gutterWidth()));
		// A body starts at its first visible line, and a header keeps its second line snug against the
		// marker line: renderers written for padded cards separate a title from its preview with blanks.
		const lines =
			this.kind === "body"
				? dropLeadingBlankLines(rendered)
				: rendered.length > 1
					? [rendered[0]!, ...dropLeadingBlankLines(rendered.slice(1))]
					: rendered;
		if (lines.length === 0) return [];
		const rail = gutterCell(toolStyle.rail.glyph, toolStyle.rail.color);
		const bareRail = theme.fg(toolStyle.rail.color, toolStyle.rail.glyph);
		return lines.map((line, index) => {
			if (index === 0 && this.kind === "header") {
				return `${gutterCell(toolStyle.marker.glyph, this.markerColor())}${line}`;
			}
			return isBlankLine(line) ? bareRail : `${rail}${line}`;
		});
	}

	invalidate(): void {
		this.component.invalidate();
	}
}
