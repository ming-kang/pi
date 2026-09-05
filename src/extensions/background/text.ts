/** Small presentation-only string helpers, including historical transcript formatting. */

/** First non-empty line of a command, trimmed — for one-line task labels. */
export function firstCommandLine(command: string): string {
	const line = command.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? command;
	return line.trim();
}

/** Compact duration like Pi's own timers: 12s, 3m05s, 1h02m. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Basename of a path, slash-normalized — compact display of output files. */
export function fileNameOf(path: string): string {
	return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}

/** The `[a · b · c]` status prefix shared by every model-facing output result. */
export function noticeLine(parts: (string | false | undefined)[]): string {
	return `[${parts.filter(Boolean).join(" · ")}]`;
}
