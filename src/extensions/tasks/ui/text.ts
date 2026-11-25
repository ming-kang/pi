/** Small presentation-only string helpers. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";

const NON_CSI_ESCAPE_PATTERN = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\)/g;
const SAFE_SGR_PATTERN = /(\x1b\[[0-9;]*m)/g;

export function cleanTaskText(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
}

/** Strip OSC/APC/DCS first so SGR codes embedded inside them cannot break sequence removal, then preserve only SGR. */
export function cleanTaskAnsiText(text: string): string {
	if (!text.includes("\x1b")) return cleanTaskText(text);
	const withoutOsc = text.replace(NON_CSI_ESCAPE_PATTERN, "");
	const parts = withoutOsc.split(SAFE_SGR_PATTERN);
	let result = "";
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (i % 2 === 1) result += part;
		else result += cleanTaskText(part);
	}
	return result;
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
