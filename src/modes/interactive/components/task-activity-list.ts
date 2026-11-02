/** Shared themed rendering for structured live task activities; executors publish data, never this UI. */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	activityStatusAsTaskStatus,
	earlierTaskActivitiesLabel,
	formatTaskActivityDuration,
	taskActivityErrorLine,
	taskActivityNameWidth,
} from "../../../core/tasks/activity.ts";
import type { TaskActivity } from "../../../core/tasks/types.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import type { Theme } from "../theme/theme.ts";
import { type StatusMarker, statusMarker } from "./status-marker.ts";

/** ` · ` before the duration column. */
const SEPARATOR_WIDTH = 3;

interface RowParts {
	activity: TaskActivity;
	marker: StatusMarker;
	name: string;
	target: string;
	duration: string;
}

function oneLine(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\s+/gu, " ").trim();
}

function marker(status: TaskActivity["status"], now: number): StatusMarker {
	return statusMarker(activityStatusAsTaskStatus(status), { now });
}

function shownDuration(activity: TaskActivity, now: number): string {
	if (activity.status === "running")
		return activity.startedAt === undefined ? "" : formatTaskActivityDuration(Math.max(0, now - activity.startedAt));
	return formatTaskActivityDuration(activity.durationMs);
}

function headWidth(row: RowParts, nameWidth: number): number {
	return visibleWidth(row.marker.glyph) + 1 + Math.max(nameWidth, visibleWidth(row.name)) + 1;
}

/** A long target gives way before the duration; durations end in one shared column. */
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
	if (room < 2) return truncateToWidth(`${head} ${theme.fg("muted", target)}${tail}`, tableWidth, "…");
	const clipped = truncateToWidth(target, room, "…");
	if (!tail) return `${head} ${theme.fg("muted", clipped)}`;
	return `${head} ${theme.fg("muted", clipped)}${" ".repeat(room - visibleWidth(clipped))}${tail}`;
}

/** Fit the retained calls and their omitted-count line to `width`; running timing is measured at repaint. */
export function taskActivityLines(
	activities: readonly TaskActivity[],
	width: number,
	theme: Theme,
	earlier = 0,
	now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const nameWidth = taskActivityNameWidth(activities);
	const rows: RowParts[] = activities.map((activity) => ({
		activity,
		marker: marker(activity.status, now),
		name: oneLine(activity.name),
		target: oneLine(activity.target ?? ""),
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
	if (earlier > 0) {
		const label = earlierTaskActivitiesLabel(earlier);
		lines.push(truncateToWidth(theme.fg("dim", label), width, "…"));
	}
	for (const row of rows) {
		lines.push(activityRow(row, nameWidth, durationWidth, tableWidth, theme));
		const error = row.activity.error ? oneLine(taskActivityErrorLine(row.activity.error)) : "";
		if (error) lines.push(truncateToWidth(`${" ".repeat(3 + nameWidth)}${theme.fg("error", error)}`, width, "…"));
	}
	return lines;
}
