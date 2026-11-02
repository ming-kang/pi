/** The inspector's Details and Output content, computed once per task snapshot and output read. */
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTaskTerminal, type TaskRead, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";

type DetailRow = [label: string, value: string, tone?: "warning"];

/**
 * Details: identity first, then the executor's input and facts as aligned rows whose values wrap
 * within their own column to `width`, then a multi-line input block. The source, status and
 * runtime are in the inspector header.
 */
export function detailLines(task: TaskSnapshot, theme: Theme, width: number): string[] {
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
 * otherwise the model-facing result.
 */
export function outputLines(task: TaskSnapshot, read: TaskRead | undefined, theme: Theme, width: number): string[] {
	const empty =
		task.status === "completed"
			? "Completed with no output."
			: isTaskTerminal(task.status)
				? "No saved output."
				: "No output yet.";
	const fromLog = streamsLog(task) && read !== undefined && !read.readError;
	const human = task.display?.text ? task.display : undefined;
	const published = human ?? task.result;
	const text = cleanTaskText((fromLog ? read.text : published?.text) || empty);
	// Logs and live progress keep their plain rendering; only a settled report's result is Markdown.
	const markdown = !fromLog && !human && task.output === "report" && task.status === "completed";
	const output = markdown
		? new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (line) => theme.fg("toolOutput", line),
			}).render(Math.max(1, width))
		: text.split("\n").map((line) => theme.fg("toolOutput", line));
	if (read?.readError) output.unshift(theme.fg("warning", "Log unavailable; showing saved result."));
	if (!fromLog && published?.truncated)
		output.push(theme.fg("warning", human ? "Output truncated." : "Saved result truncated."));
	return output;
}
