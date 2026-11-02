/** Compact, bounded formatting of an Agent's tool-call activity, shared by the Transcript and /tasks. */
import { isAbsolute, relative, sep, win32 } from "node:path";
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
