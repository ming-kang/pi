/** Compact, bounded formatting of an Agent's tool-call activity, shared by the Transcript and /tasks. */
import { boundText } from "../../core/tasks/output.ts";
import type { AgentActivity } from "./types.ts";

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

/** A short display target; full arguments remain available in Tasks Output. */
export function activityTarget(name: string, args: unknown): string {
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
		return clipText((first ?? value).trim().replace(/[ \t]+/gu, " "), 160);
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

export function formatActivityDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function activityGlyph(status: AgentActivity["status"]): string {
	switch (status) {
		case "running":
			return "…";
		case "ok":
			return "✓";
		case "error":
			return "✗";
		case "cancelled":
			return "⊘";
	}
}

/** The Transcript's `glyph tool target · duration` form, plus an indented failure excerpt. */
export function activityText(activity: AgentActivity, includeError = true): string {
	const target = targetOf(activity);
	const duration = formatActivityDuration(activity.durationMs);
	const line = `${activityGlyph(activity.status)} ${activity.name}${target ? ` ${target}` : ""}${duration ? ` · ${duration}` : ""}`;
	return includeError && activity.error
		? `${line}\n    ${clipText(activity.error, 1000).replaceAll("\n", "\n    ")}`
		: line;
}

export function activitiesText(activities: readonly AgentActivity[]): string {
	return activities.map((activity) => activityText(activity)).join("\n");
}
