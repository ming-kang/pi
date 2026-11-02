/** The themed tool-call list of a running Agent's expanded Transcript row. */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusMarker } from "../../modes/interactive/components/status-marker.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { activityMarker, errorLine, formatActivityDuration, nameColumnWidth, targetOf } from "./activity.ts";
import type { AgentActivity } from "./types.ts";

/** ` · ` before the duration column. */
const SEPARATOR_WIDTH = 3;

/** One row's text and marker before styling; widths are measured on these. */
interface RowParts {
	activity: AgentActivity;
	marker: StatusMarker;
	name: string;
	target: string;
	duration: string;
}

/** One line of tool-call text with no terminal sequences or control characters; the Agent's arguments are untrusted. */
function oneLine(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\s+/gu, " ").trim();
}

/** A finished call's own duration; a running call's time since it started. */
function shownDuration(activity: AgentActivity, now: number): string {
	if (activity.status === "running")
		return activity.startedAt === undefined ? "" : formatActivityDuration(Math.max(0, now - activity.startedAt));
	return formatActivityDuration(activity.durationMs);
}

/** `glyph name` with the padding that lines targets up, plus the space before the target. */
function headWidth(row: RowParts, nameWidth: number): number {
	return visibleWidth(row.marker.glyph) + 1 + Math.max(nameWidth, visibleWidth(row.name)) + 1;
}

/**
 * `glyph name target · duration`, with the durations right-aligned in one column ending at
 * `tableWidth`. A long target gives way before the duration does.
 */
function activityRow(
	row: RowParts,
	nameWidth: number,
	durationWidth: number,
	tableWidth: number,
	theme: Theme,
): string {
	const { marker, name, target, duration } = row;
	const padding = " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
	const head = `${theme.fg(marker.color, marker.glyph)} ${theme.fg("toolTitle", name)}${padding}`;
	const durationPad = " ".repeat(Math.max(0, durationWidth - visibleWidth(duration)));
	const tail = duration ? `${theme.fg("dim", " · ")}${durationPad}${theme.fg("dim", duration)}` : "";
	if (!target && !tail) return truncateToWidth(head.trimEnd(), tableWidth, "…");
	const room = tableWidth - headWidth(row, nameWidth) - (tail ? SEPARATOR_WIDTH + durationWidth : 0);
	// Without room for even a clipped target, the whole row is clipped instead.
	if (room < 2) return truncateToWidth(`${head} ${theme.fg("muted", target)}${tail}`, tableWidth, "…");
	const clipped = truncateToWidth(target, room, "…");
	// A row without a duration ends at its target instead of trailing blanks.
	if (!tail) return `${head} ${theme.fg("muted", clipped)}`;
	return `${head} ${theme.fg("muted", clipped)}${" ".repeat(room - visibleWidth(clipped))}${tail}`;
}

/**
 * Themed rows for `activities`: one row per call with an aligned tool-name column, durations right-aligned in one column, and a failed call's first
 * error line beneath it. The table is as wide as its longest row, at most `width`. Measured at
 * `now`, a running call shows a spinner frame and the time since it started.
 */
export function activityLines(
	activities: readonly AgentActivity[],
	width: number,
	theme: Theme,
	now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const nameWidth = nameColumnWidth(activities);
	const rows: RowParts[] = activities.map((activity) => ({
		activity,
		marker: activityMarker(activity.status, now),
		name: oneLine(activity.name),
		target: oneLine(targetOf(activity)),
		duration: shownDuration(activity, now),
	}));
	const durationWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.duration)));
	const tailWidth = durationWidth ? SEPARATOR_WIDTH + durationWidth : 0;
	const naturalWidth = Math.max(
		0,
		...rows.map((row) => headWidth(row, nameWidth) + visibleWidth(row.target) + tailWidth),
	);
	const tableWidth = Math.min(width, naturalWidth);
	const lines: string[] = [];
	for (const row of rows) {
		lines.push(activityRow(row, nameWidth, durationWidth, tableWidth, theme));
		const error = row.activity.error ? oneLine(errorLine(row.activity.error)) : "";
		if (error) lines.push(truncateToWidth(`${" ".repeat(3 + nameWidth)}${theme.fg("error", error)}`, width, "…"));
	}
	return lines;
}
