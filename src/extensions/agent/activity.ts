/** Compact, bounded formatting of an Agent's tool-call activity, shared by the Transcript and /tasks. */
import { isAbsolute, relative, sep, win32 } from "node:path";
import { boundText } from "../../core/tasks/output.ts";
import type { TaskStatus } from "../../core/tasks/types.ts";
import { type StatusMarker, statusMarker } from "../../modes/interactive/components/status-marker.ts";
import { formatDuration } from "../../utils/duration.ts";
import type { AgentActivity } from "./types.ts";

/** The tool-name column never grows past this, so one long name cannot push every target away. */
const NAME_COLUMN_MAX = 8;
const ERROR_LINE_CHARS = 160;

export function clipText(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	return `${boundText(text, Math.max(1, bytes - 1))}…`;
}

export function compactArguments(args: unknown): string {
	try {
		return clipText(JSON.stringify(args) ?? String(args), 512).replace(/\s+/gu, " ");
	} catch {
		return "{…}";
	}
}

/** A fully qualified absolute path; a rooted path without a drive would resolve against the process drive. */
function isQualifiedAbsolute(path: string): boolean {
	return process.platform === "win32" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(path) : isAbsolute(path);
}

/**
 * An absolute path inside `cwd` as a forward-slash relative path. Relative paths and paths outside
 * `cwd` are returned unchanged; nothing is ever resolved against the process working directory.
 */
export function relativeToCwd(path: string, cwd: string | undefined): string {
	if (!cwd || !isQualifiedAbsolute(path) || !isQualifiedAbsolute(cwd)) return path;
	// node:path compares case-insensitively on Windows and exactly elsewhere.
	const rel = relative(cwd, path);
	if (rel === "") return ".";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)) return path;
	return rel.split(sep).join("/");
}

/** A short display target; full arguments remain available in Tasks Output. */
export function activityTarget(name: string, args: unknown, cwd?: string): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return compactArguments(args);
	const record = args as Record<string, unknown>;
	const keys =
		name === "bash" || name === "powershell"
			? ["command"]
			: name === "grep" || name === "find"
				? ["pattern", "path"]
				: ["path", "pattern", "command"];
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string" || !value.trim()) continue;
		const first = key === "command" ? value.split(/\r?\n/).find((line) => line.trim()) : value;
		const text = (first ?? value).trim().replace(/[ \t]+/gu, " ");
		return clipText(key === "path" ? relativeToCwd(text, cwd) : text, 160);
	}
	return compactArguments(args);
}

/** The stored display target, or one derived from the bounded arguments. */
export function targetOf(activity: AgentActivity): string {
	if (activity.target) return activity.target;
	try {
		return activityTarget(activity.name, JSON.parse(activity.args));
	} catch {
		return activity.args;
	}
}

/** `Nms` under a second, `N.Ns` under a minute, then the shared `1m 5s` form. */
export function formatActivityDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	const millis = Math.round(ms);
	if (millis < 1000) return `${millis}ms`;
	const tenths = Math.round(ms / 100) / 10;
	return tenths < 60 ? `${tenths.toFixed(1)}s` : formatDuration(ms);
}

const TASK_STATUS: Record<AgentActivity["status"], TaskStatus> = {
	running: "running",
	ok: "completed",
	error: "failed",
	cancelled: "cancelled",
};

/**
 * A call's glyph and color in the shared task status vocabulary, so a call reads like the task
 * rows around it in /tasks. Pass `now` to animate a running call as a spinner frame.
 */
export function activityMarker(status: AgentActivity["status"], now?: number): StatusMarker {
	return statusMarker(TASK_STATUS[status], now === undefined ? undefined : { now });
}

export function activityGlyph(status: AgentActivity["status"]): string {
	return activityMarker(status).glyph;
}

/** Width of the tool-name column for the calls being shown. */
export function nameColumnWidth(activities: readonly AgentActivity[]): number {
	return Math.min(NAME_COLUMN_MAX, Math.max(0, ...activities.map((activity) => activity.name.length)));
}

/** Pads a name only when a target follows it, so a bare name leaves no trailing blanks. */
export function paddedName(activity: AgentActivity, width: number): string {
	return targetOf(activity) ? activity.name.padEnd(width) : activity.name;
}

/** The first non-empty line of a failure, clipped to one display line. */
export function errorLine(error: string): string {
	const line = (error.split(/\r?\n/u).find((part) => part.trim()) ?? "").replace(/\s+/gu, " ").trim();
	const chars = Array.from(line);
	return chars.length > ERROR_LINE_CHARS ? `${chars.slice(0, ERROR_LINE_CHARS - 1).join("")}…` : line;
}

/** `glyph name target · duration`, plus a failure line under the target column. */
export function activityText(activity: AgentActivity, nameWidth = nameColumnWidth([activity])): string {
	const target = targetOf(activity);
	const duration = formatActivityDuration(activity.durationMs);
	const line = `${activityGlyph(activity.status)} ${paddedName(activity, nameWidth)}${target ? ` ${target}` : ""}${duration ? ` · ${duration}` : ""}`;
	const error = activity.error ? errorLine(activity.error) : "";
	return error ? `${line}\n${" ".repeat(3 + nameWidth)}${error}` : line;
}

/** The line standing for calls no longer retained. */
export function earlierLabel(earlier: number): string {
	return `… ${earlier} earlier tool ${earlier === 1 ? "call" : "calls"}`;
}

/** The plain /tasks display: a count of calls no longer retained, then one aligned row per call. */
export function activitiesText(activities: readonly AgentActivity[], earlier = 0): string {
	const width = nameColumnWidth(activities);
	const rows = activities.map((activity) => activityText(activity, width));
	return (earlier > 0 ? [earlierLabel(earlier), ...rows] : rows).join("\n");
}
