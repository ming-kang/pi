/** The inspector's Details and Output content, computed once per task snapshot and output read. */
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { isTaskTerminal, type TaskRead, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";

export interface TaskLines {
	info: string[];
	output: string[];
}

/** Details: the source, a single-line input and executor facts as aligned rows, then a multi-line input block. */
function detailLines(task: TaskSnapshot, theme: Theme): string[] {
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
	const rows: Array<[string, string]> = [];
	// Without an input, the title is the only description of the work.
	if (!input) rows.push(["Title", cleanTaskText(task.title)]);
	else if (inputLines.length <= 1) rows.push([input.label, inputLines[0] ?? ""]);
	for (const [label, value] of task.facts ?? []) rows.push([cleanTaskText(label), cleanTaskText(value)]);
	if (task.outputPath) rows.push(["Log", cleanTaskText(task.outputPath)]);
	const width = Math.max(9, ...rows.map(([label]) => visibleWidth(label))) + 1;
	const lines = [
		theme.fg("accent", cleanTaskText(task.label)),
		...rows.map(([label, value]) => label + " ".repeat(width - visibleWidth(label)) + value),
	];
	if (input && inputLines.length > 1) lines.push("", theme.fg("accent", input.label), ...inputLines);
	if (input?.truncated) lines.push(theme.fg("warning", `[Saved ${input.label.toLowerCase()} truncated.]`));
	return lines;
}

export function taskLines(
	task: TaskSnapshot,
	read: TaskRead | undefined,
	theme: Theme,
	outputWidth: number,
): TaskLines {
	const empty =
		task.status === "completed"
			? "Completed with no output."
			: isTaskTerminal(task.status)
				? "No saved output."
				: "No output yet.";
	const text = cleanTaskText((read ? read.text : task.result?.text) || empty);
	// Logs and live progress keep their plain rendering; only a settled report is Markdown.
	const output =
		task.output === "report" && task.status === "completed"
			? new Markdown(text, 0, 0, getMarkdownTheme(), {
					color: (line) => theme.fg("toolOutput", line),
				}).render(Math.max(1, outputWidth))
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
	if ((!read || read.readError) && task.result?.truncated) output.push(theme.fg("warning", "Saved result truncated."));
	return { info: detailLines(task, theme), output };
}
