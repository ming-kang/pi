/** Theme-free formatting shared by portable task displays and interactive activity rows. */
import { formatDuration } from "../../utils/duration.ts";
import type { TaskActivity, TaskStatus } from "./types.ts";

const NAME_COLUMN_MAX = 8;
const ERROR_LINE_CHARS = 160;

const TASK_STATUS: Record<TaskActivity["status"], TaskStatus> = {
	running: "running",
	ok: "completed",
	error: "failed",
	cancelled: "cancelled",
};

export function activityStatusAsTaskStatus(status: TaskActivity["status"]): TaskStatus {
	return TASK_STATUS[status];
}

/** `Nms` under a second, `N.Ns` under a minute, then the shared `1m 5s` form. */
export function formatTaskActivityDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	const millis = Math.round(ms);
	if (millis < 1000) return `${millis}ms`;
	const tenths = Math.round(ms / 100) / 10;
	return tenths < 60 ? `${tenths.toFixed(1)}s` : formatDuration(ms);
}

/** The tool-name column never grows enough for one long name to push every target away. */
export function taskActivityNameWidth(activities: readonly TaskActivity[]): number {
	return Math.min(NAME_COLUMN_MAX, Math.max(0, ...activities.map((activity) => activity.name.length)));
}

/** The first non-empty line of a failure, clipped to one display line. */
export function taskActivityErrorLine(error: string): string {
	const line = (error.split(/\r?\n/u).find((part) => part.trim()) ?? "").replace(/\s+/gu, " ").trim();
	const chars = Array.from(line);
	return chars.length > ERROR_LINE_CHARS ? `${chars.slice(0, ERROR_LINE_CHARS - 1).join("")}…` : line;
}

export function earlierTaskActivitiesLabel(earlier: number): string {
	return `… ${earlier} earlier tool ${earlier === 1 ? "call" : "calls"}`;
}

const PLAIN_GLYPH: Record<TaskActivity["status"], string> = {
	running: "›",
	ok: "✓",
	error: "×",
	cancelled: "○",
};

/** Portable `glyph name target · duration`, plus a failure line under the target column. */
export function taskActivityText(activity: TaskActivity, nameWidth = taskActivityNameWidth([activity])): string {
	const target = activity.target ?? "";
	const name = target ? activity.name.padEnd(nameWidth) : activity.name;
	const duration = formatTaskActivityDuration(activity.durationMs);
	const line = `${PLAIN_GLYPH[activity.status]} ${name}${target ? ` ${target}` : ""}${duration ? ` · ${duration}` : ""}`;
	const error = activity.error ? taskActivityErrorLine(activity.error) : "";
	return error ? `${line}\n${" ".repeat(3 + nameWidth)}${error}` : line;
}

/** The portable display: omitted-call count, then one aligned row per retained activity. */
export function taskActivitiesText(activities: readonly TaskActivity[], earlier = 0): string {
	const width = taskActivityNameWidth(activities);
	const rows = activities.map((activity) => taskActivityText(activity, width));
	return (earlier > 0 ? [earlierTaskActivitiesLabel(earlier), ...rows] : rows).join("\n");
}
