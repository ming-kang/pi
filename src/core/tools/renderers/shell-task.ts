import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { highlightCode } from "../../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { isTaskTerminal } from "../../tasks/types.ts";
import type { TaskViewProvider } from "../../tasks/view.ts";

/** Shared by the native Bash and PowerShell executors. */
export const shellTaskView: TaskViewProvider = {
	outputMode: "tail",
	create({ theme }) {
		const information = new Text("", 0, 0);
		let outputText = "";
		let previousCommand: string | undefined;
		let highlightedCommand = "";
		const info = {
			render: (width: number) => information.render(width),
			invalidate() {
				previousCommand = undefined;
				information.invalidate();
			},
		};
		const output = { render: () => outputText.split("\n"), invalidate() {} };
		const clean = (text: string) => sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
		return {
			info,
			output,
			update(task, read) {
				const name = task.kind === "powershell" ? "PowerShell" : "Bash";
				const command = clean(task.command ?? task.title);
				if (command !== previousCommand) {
					previousCommand = command;
					highlightedCommand = highlightCode(command, task.kind === "powershell" ? "powershell" : "bash").join(
						"\n",
					);
				}
				information.setText(
					[
						theme.fg("accent", name),
						`Command   ${highlightedCommand}`,
						...(task.commandTruncated ? ["[Saved command truncated.]"] : []),
						...(task.cwd ? [`Directory ${clean(task.cwd)}`] : []),
						...(task.outputPath ? [`Log       ${clean(task.outputPath)}`] : []),
						...(task.exitCode !== undefined ? [`Exit      ${task.exitCode ?? "signal"}`] : []),
						...(read?.readError ? [theme.fg("error", clean(read.readError))] : []),
					].join("\n"),
				);
				const saved = task.result?.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const text = read?.text ?? saved ?? task.projection?.text ?? "";
				const empty =
					task.status === "completed"
						? "Completed with no output."
						: isTaskTerminal(task.status)
							? "No saved output."
							: "No output yet.";
				outputText = theme.fg("toolOutput", clean(text || empty));
				if (read?.readError)
					outputText = `${theme.fg("warning", "Log unavailable; showing saved result.")}\n${outputText}`;
				if ((!read || read.readError) && task.resultTruncated)
					outputText += `\n${theme.fg("warning", "Saved result truncated.")}`;
			},
		};
	},
};
