/** The inspector's Details and Output content, computed once per task snapshot and output read. */
import { Markdown } from "@earendil-works/pi-tui";
import { isTaskTerminal, type TaskRead, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { getMarkdownTheme, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import { cleanTaskText } from "./text.ts";

export interface TaskLines {
	info: string[];
	output: string[];
}

const SHELLS: Record<string, { name: string; language: string }> = {
	bash: { name: "Bash", language: "bash" },
	powershell: { name: "PowerShell", language: "powershell" },
};

export function taskLines(
	task: TaskSnapshot,
	read: TaskRead | undefined,
	theme: Theme,
	outputWidth: number,
): TaskLines {
	const shell = SHELLS[task.kind];
	const command = cleanTaskText(task.command ?? task.title);
	const [first = "", ...rest] = shell ? highlightCode(command, shell.language) : command.split("\n");
	const info = task.info
		? [
				...cleanTaskText(task.info.text)
					.split("\n")
					.map((line, index) => theme.fg(index === 0 ? "accent" : "toolOutput", line)),
				...(task.info.truncated ? [theme.fg("warning", "[Saved details truncated.]")] : []),
			]
		: [
				theme.fg("accent", shell?.name ?? task.kind),
				`${task.command === undefined ? "Title     " : "Command   "}${first}`,
				...rest,
				...(task.commandTruncated ? ["[Saved command truncated.]"] : []),
				...(task.cwd ? [`Directory ${cleanTaskText(task.cwd)}`] : []),
				...(task.outputPath ? [`Log       ${cleanTaskText(task.outputPath)}`] : []),
				// The panel lists task and read diagnostics above these lines.
				...(task.exitCode !== undefined ? [`Exit      ${task.exitCode ?? "signal"}`] : []),
			];

	const saved = task.result?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const empty =
		task.status === "completed"
			? "Completed with no output."
			: isTaskTerminal(task.status)
				? "No saved output."
				: "No output yet.";
	const text = cleanTaskText((read ? read.text : saved) || empty);
	// Agent Text and shell logs keep their normal rendering; only a settled report is Markdown.
	const output =
		task.kind === "agent" && task.status === "completed"
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
	if ((!read || read.readError) && task.resultTruncated) output.push(theme.fg("warning", "Saved result truncated."));
	return { info, output };
}
