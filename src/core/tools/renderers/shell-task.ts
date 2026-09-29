import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { highlightCode } from "../../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import type { TaskViewProvider } from "../../tasks/view.ts";

/** Shared by the native Bash and PowerShell executors. */
export const shellTaskView: TaskViewProvider = {
	outputMode: "tail",
	create({ theme }) {
		const info = new Text("", 0, 0);
		let outputText = "";
		const output = { render: () => outputText.split("\n"), invalidate() {} };
		const clean = (text: string) => sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
		return {
			info,
			output,
			update(task, read) {
				const name = task.kind === "powershell" ? "PowerShell" : "Bash";
				info.setText(
					[
						theme.fg("accent", name),
						`Command   ${highlightCode(clean(task.command ?? task.title), task.kind === "powershell" ? "powershell" : "bash").join("\n")}`,
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
				outputText = theme.fg(
					"toolOutput",
					clean(read?.text ?? saved ?? task.projection?.text ?? "No output yet."),
				);
			},
		};
	},
};
