/** Bordered pane chrome: the title sits in the top border and a status in the bottom one. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Columns from a pane's left edge to its title: the corner, one rule cell and a space. */
export const TITLE_INDENT = 3;

interface FrameOptions {
	width: number;
	theme: Theme;
	/** The focused pane's border is accented. */
	accent: boolean;
	/** Styled title for the top border. */
	title?: string;
	/** Styled text right-aligned in the bottom border, such as a scroll range. */
	status?: string;
	/** Content rows, clipped or padded to the inner width. */
	rows: string[];
	/** Index of the content row drawn as a `├──┤` rule joined to the frame; that row's text is ignored. */
	divider?: number;
}

export interface Frame {
	lines: string[];
	/** Where the bottom-border status starts (pane-relative) and how many cells it occupies. */
	status: { x: number; width: number };
}

/** Pads or clips one content row to exactly `width` cells. */
export const fitCell = (text: string, width: number): string => truncateToWidth(text, Math.max(1, width), "…", true);

export function framePane(options: FrameOptions): Frame {
	const { width, theme, rows } = options;
	const border = (text: string) => theme.fg(options.accent ? "borderAccent" : "borderMuted", text);
	const inner = Math.max(1, width - 2);
	// `┌─ title ──┐` and `└── status ─┘`: three cells of corner, rule and space frame the text.
	const room = Math.max(0, width - 5);
	const title = options.title && room > 0 ? truncateToWidth(options.title, room, "…") : "";
	const status = options.status && room > 0 ? truncateToWidth(options.status, room, "…") : "";
	const top = title
		? border("┌─ ") + title + border(` ${"─".repeat(Math.max(0, width - 5 - visibleWidth(title)))}┐`)
		: border(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
	const statusWidth = visibleWidth(status);
	const bottom = status
		? border(`└${"─".repeat(Math.max(0, width - 5 - statusWidth))} `) + status + border(" ─┘")
		: border(`└${"─".repeat(Math.max(0, width - 2))}┘`);
	return {
		lines: [
			top,
			...rows.map((row, index) =>
				index === options.divider
					? border(`├${"─".repeat(Math.max(0, width - 2))}┤`)
					: border("│") + fitCell(row, inner) + border("│"),
			),
			bottom,
		],
		status: { x: Math.max(0, width - 3 - statusWidth), width: statusWidth },
	};
}
