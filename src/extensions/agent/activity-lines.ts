/**
 * The themed tool-call list of a running Agent. The Transcript's expanded row and the /tasks
 * Output both render through `activityLines`, so the two cannot drift apart.
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import {
	activityGlyph,
	earlierLabel,
	errorLine,
	formatActivityDuration,
	nameColumnWidth,
	targetOf,
} from "./activity.ts";
import type { AgentActivity } from "./types.ts";

type ActivityColor = "warning" | "success" | "error" | "muted";

function statusColor(status: AgentActivity["status"]): ActivityColor {
	switch (status) {
		case "running":
			return "warning";
		case "ok":
			return "success";
		case "error":
			return "error";
		case "cancelled":
			return "muted";
	}
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

/** `glyph name target · duration`; a long target gives way before the duration does. */
function activityRow(activity: AgentActivity, nameWidth: number, width: number, now: number, theme: Theme): string {
	const separator = theme.fg("dim", " · ");
	const name = oneLine(activity.name);
	const target = oneLine(targetOf(activity));
	const duration = shownDuration(activity, now);
	const head = `${theme.fg(statusColor(activity.status), activityGlyph(activity.status))} ${theme.fg("toolTitle", name)}`;
	const padding = " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
	const tail = duration ? `${separator}${theme.fg("dim", duration)}` : "";
	if (!target) return truncateToWidth(head + tail, width, "…");
	const room = width - visibleWidth(head) - padding.length - 1 - visibleWidth(tail);
	// Without room for even a clipped target, the whole row is clipped instead.
	if (room < 2) return truncateToWidth(`${head}${padding} ${theme.fg("muted", target)}${tail}`, width, "…");
	return `${head}${padding} ${theme.fg("muted", truncateToWidth(target, room, "…"))}${tail}`;
}

/**
 * Themed rows for `activities`: an optional `… N earlier tool calls` line, then one row per call
 * with an aligned tool-name column and a failed call's first error line beneath it. Every line fits
 * `width`; a running call shows the time since it started, measured at `now`.
 */
export function activityLines(
	activities: readonly AgentActivity[],
	earlier: number,
	width: number,
	theme: Theme,
	now = Date.now(),
): string[] {
	if (width <= 0) return [];
	const nameWidth = nameColumnWidth(activities);
	const lines = earlier > 0 ? [truncateToWidth(theme.fg("dim", earlierLabel(earlier)), width, "…")] : [];
	for (const activity of activities) {
		lines.push(activityRow(activity, nameWidth, width, now, theme));
		const error = activity.error ? oneLine(errorLine(activity.error)) : "";
		if (error) lines.push(truncateToWidth(`${" ".repeat(3 + nameWidth)}${theme.fg("error", error)}`, width, "…"));
	}
	return lines;
}
