/** The inspector's Details and Output content, computed once per task snapshot and output read. */
import { Markdown, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTaskTerminal, type TaskRead, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { taskActivityLines } from "../../../modes/interactive/components/task-activity-list.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { formatDuration } from "../../../utils/duration.ts";
import { formatTokens } from "../../../utils/number.ts";
import { cleanTaskAnsiText, cleanTaskText } from "./text.ts";

type DetailRow = [label: string, value: string, tone?: "warning"];

export const TASK_IDLE_DISPLAY_MS = 15_000;

function formatUsageRow(task: TaskSnapshot): string | undefined {
	const usage = task.usage;
	if (!usage) return undefined;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite || usage.totalTokens;
	const cost = usage.cost.total;
	if (tokens <= 0 && cost <= 0) return undefined;
	const parts: string[] = [];
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
	if (cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
	return parts.join(" · ");
}

/**
 * Details: identity first, then the executor's input and facts as aligned rows whose values wrap
 * within their own column to `width`, then a multi-line input block. The source, status and
 * runtime are in the inspector header.
 */
export function detailLines(task: TaskSnapshot, theme: Theme, width: number, now = Date.now()): string[] {
	const input = task.input && {
		...task.input,
		label: cleanTaskText(task.input.label),
		text: cleanTaskText(task.input.text),
	};
	const inputLines = input
		? input.language
			? highlightCode(input.text, input.language)
			: input.text.split("\n")
		: [];
	const rows: DetailRow[] = [["Task ID", task.id]];
	if (task.error) rows.push(["Error", cleanTaskText(task.error).replace(/\n/g, " "), "warning"]);
	// Without an input, the title is the only complete description of the work.
	if (!input) rows.push(["Title", cleanTaskText(task.title)]);
	else if (inputLines.length <= 1) rows.push([input.label, inputLines[0] ?? ""]);
	for (const [label, value] of task.facts ?? []) rows.push([cleanTaskText(label), cleanTaskText(value)]);
	const usageSummary = formatUsageRow(task);
	if (usageSummary) rows.push(["Usage", usageSummary]);
	if (!isTaskTerminal(task.status) && task.lastOutputAt !== undefined) {
		const idleMs = now - task.lastOutputAt;
		if (idleMs >= TASK_IDLE_DISPLAY_MS) rows.push(["Idle", `No output for ${formatDuration(idleMs)}`]);
	}
	// A fact that already names the output file would repeat it.
	const shownAsFact = task.facts?.some(([, value]) => value === task.outputPath);
	if (task.outputPath && !shownAsFact)
		rows.push([task.output === "log" ? "Log" : "Full report", cleanTaskText(task.outputPath)]);
	const labelWidth = Math.max(9, ...rows.map(([label]) => visibleWidth(label))) + 1;
	// Values wrap inside their own column, so continuation lines hang under the first value line.
	const valueWidth = Math.max(1, width - labelWidth);
	const lines = rows.flatMap(([label, value, tone]) =>
		wrapTextWithAnsi(value, valueWidth).map((line, index) => {
			const lead = index ? " ".repeat(labelWidth) : label + " ".repeat(labelWidth - visibleWidth(label));
			return lead + (tone ? theme.fg(tone, line) : line);
		}),
	);
	if (input && inputLines.length > 1) lines.push("", theme.fg("accent", input.label), ...inputLines);
	if (input?.truncated) lines.push(theme.fg("warning", `[Saved ${input.label.toLowerCase()} truncated.]`));
	return lines;
}

/** Whether Output streams from a file; any other task shows what its executor published. */
export function streamsLog(task: TaskSnapshot): boolean {
	return task.output === "log" && task.outputPath !== undefined;
}

/**
 * Output: a log streams from its file through bounded reads. Any other task shows what its
 * executor published, current with every snapshot: the human `display` when there is one,
 * otherwise the model-facing result. Structured live activities share the interactive renderer;
 * their bounded text remains the fallback for other hosts and settled snapshots.
 */
export function outputLines(task: TaskSnapshot, read: TaskRead | undefined, theme: Theme, width: number): string[] {
	const empty =
		task.status === "completed"
			? "Completed with no output."
			: isTaskTerminal(task.status)
				? "No saved output."
				: "No output yet.";
	const fromLog = streamsLog(task) && read !== undefined && !read.readError;
	const human = task.display?.text || task.display?.activities?.length ? task.display : undefined;
	const published = human ?? task.result;
	const raw = (fromLog ? read.text : published?.text) || empty;
	const activities =
		!fromLog && !isTaskTerminal(task.status) && human?.activities?.length ? human.activities : undefined;
	// Logs and plain live progress keep their plain rendering; only a settled report's result is Markdown.
	const markdown = !fromLog && !human && task.output === "report" && task.status === "completed";
	const text = activities || markdown ? cleanTaskText(raw) : cleanTaskAnsiText(raw);
	const output = [
		...(activities
			? taskActivityLines(activities, Math.max(1, width), theme, human?.earlierActivities ?? 0)
			: markdown
				? new Markdown(text, 0, 0, getMarkdownTheme(), {
						color: (line) => theme.fg("toolOutput", line),
					}).render(Math.max(1, width))
				: text
						.split("\n")
						.map((line) =>
							line.includes("\x1b") ? `${theme.fg("toolOutput", line)}\x1b[0m` : theme.fg("toolOutput", line),
						)),
	];
	if (read?.readError) output.unshift(theme.fg("warning", "Log unavailable; showing saved result."));
	if (!fromLog && published?.truncated)
		output.push(theme.fg("warning", human ? "Output truncated." : "Saved result truncated."));
	return output;
}

const ANSI_TOKEN = /(\x1b\[[0-9;]*m)/g;

/** Highlight case-insensitive matches inside ANSI-styled lines without corrupting escape sequences. */
function highlightLineMatches(line: string, needle: string, active: boolean, theme: Theme): string {
	const highlight = (segment: string) =>
		active
			? theme.style(segment, { fg: "accent", inverse: true, bold: true })
			: theme.style(segment, { inverse: true });
	const parts = line.split(ANSI_TOKEN);
	let result = "";
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (i % 2 === 1) {
			result += part;
			continue;
		}
		const lower = part.toLowerCase();
		let cursor = 0;
		let hit = lower.indexOf(needle, cursor);
		while (hit !== -1) {
			if (hit > cursor) result += part.slice(cursor, hit);
			result += highlight(part.slice(hit, hit + needle.length));
			cursor = hit + needle.length;
			hit = lower.indexOf(needle, cursor);
		}
		if (cursor < part.length) result += part.slice(cursor);
	}
	return result;
}

export function applyOutputSearch(
	lines: string[],
	rawQuery: string,
	matchIndex: number,
	theme: Theme,
): { lines: string[]; matchLines: number[]; activeIndex: number } {
	const needle = rawQuery.trim().toLowerCase();
	if (!needle) return { lines, matchLines: [], activeIndex: -1 };
	const matchLines: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (stripTerminalSequences(lines[i]!).toLowerCase().includes(needle)) matchLines.push(i);
	}
	if (matchLines.length === 0) return { lines, matchLines, activeIndex: -1 };
	const activeIndex = ((matchIndex % matchLines.length) + matchLines.length) % matchLines.length;
	const activeLine = matchLines[activeIndex]!;
	const matchSet = new Set(matchLines);
	const highlighted = lines.map((line, index) =>
		matchSet.has(index) ? highlightLineMatches(line, needle, index === activeLine, theme) : line,
	);
	return { lines: highlighted, matchLines, activeIndex };
}
