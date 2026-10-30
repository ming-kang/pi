/** The inspector's Details and Output content, computed once per task snapshot and output read. */
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { isTaskTerminal, type TaskRead, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";

type DetailRow = [label: string, value: string, tone?: "warning"];

/**
 * Details: source, identity and status first, then the executor's input and facts as aligned
 * rows, then a multi-line input block. `status` changes with runtime, so the caller supplies it.
 */
export function detailLines(task: TaskSnapshot, status: string, theme: Theme): string[] {
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
	const rows: DetailRow[] = [
		["Source", cleanTaskText(task.label)],
		["Task ID", task.id],
		["Status", status],
	];
	if (task.error) rows.push(["Error", cleanTaskText(task.error).replace(/\n/g, " "), "warning"]);
	// Without an input, the title is the only description of the work.
	if (!input) rows.push(["Title", cleanTaskText(task.title)]);
	else if (inputLines.length <= 1) rows.push([input.label, inputLines[0] ?? ""]);
	for (const [label, value] of task.facts ?? []) rows.push([cleanTaskText(label), cleanTaskText(value)]);
	if (task.outputPath) rows.push(["Log", cleanTaskText(task.outputPath)]);
	const width = Math.max(9, ...rows.map(([label]) => visibleWidth(label))) + 1;
	const lines = rows.map(
		([label, value, tone]) =>
			label + " ".repeat(width - visibleWidth(label)) + (tone ? theme.fg(tone, value) : value),
	);
	if (input && inputLines.length > 1) lines.push("", theme.fg("accent", input.label), ...inputLines);
	if (input?.truncated) lines.push(theme.fg("warning", `[Saved ${input.label.toLowerCase()} truncated.]`));
	return lines;
}

/**
 * Output: a log streams from its file through bounded reads; any other task shows its
 * published result, current with every snapshot, followed by its human-only display.
 */
export function outputLines(task: TaskSnapshot, read: TaskRead | undefined, theme: Theme, width: number): string[] {
	const empty =
		task.status === "completed"
			? "Completed with no output."
			: isTaskTerminal(task.status)
				? "No saved output."
				: "No output yet.";
	const fromLog = task.outputPath !== undefined && read !== undefined;
	const text = cleanTaskText((fromLog ? read.text : task.result?.text) || empty);
	// Logs and live progress keep their plain rendering; only a settled report is Markdown.
	const output =
		task.output === "report" && task.status === "completed"
			? new Markdown(text, 0, 0, getMarkdownTheme(), {
					color: (line) => theme.fg("toolOutput", line),
				}).render(Math.max(1, width))
			: text.split("\n").map((line) => theme.fg("toolOutput", line));
	if (read?.readError) output.unshift(theme.fg("warning", "Log unavailable; showing saved result."));
	if (task.display?.text) {
		if (output.length) output.push("");
		output.push(
			...cleanTaskText(task.display.text)
				.split("\n")
				.map((line) => theme.fg("toolOutput", line)),
		);
	}
	if (task.display?.truncated) output.push(theme.fg("warning", "Additional output truncated."));
	if ((!fromLog || read.readError) && task.result?.truncated)
		output.push(theme.fg("warning", "Saved result truncated."));
	return output;
}
