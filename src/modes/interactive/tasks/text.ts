/** Small presentation-only string helpers, including historical transcript formatting. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";

export function cleanTaskText(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
}

/** First non-empty line of a command, trimmed — for one-line task labels. */
export function firstCommandLine(command: string): string {
	const line = command.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? command;
	return line.trim();
}

/** Basename of a path, slash-normalized — compact display of output files. */
export function fileNameOf(path: string): string {
	return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}

/** Relative age of a finished timestamp: 5s ago, 3m ago, 2h ago, 4d ago. */
export function formatAge(endedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - endedAt) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** The `[a · b · c]` status prefix shared by every context-facing output result. */
export function noticeLine(parts: (string | false | undefined)[]): string {
	return `[${parts.filter(Boolean).join(" · ")}]`;
}
