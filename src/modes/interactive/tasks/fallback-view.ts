import { Text } from "@earendil-works/pi-tui";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import type { TaskViewProvider } from "../../../core/tasks/view.ts";
import { cleanTaskText } from "./text.ts";

/** Saved text remains readable even when its renderer is unavailable. */
export const fallbackTaskView: TaskViewProvider = {
	outputMode: "snapshot",
	create({ theme }) {
		const info = new Text("", 0, 0);
		const output = new Text("", 0, 0);
		return {
			info,
			output,
			update(task, read) {
				info.setText(
					cleanTaskText(
						`${task.kind}\n${task.command ?? task.title}${task.cwd ? `\nDirectory ${task.cwd}` : ""}${task.outputPath ? `\nLog ${task.outputPath}` : ""}`,
					),
				);
				const text =
					task.result?.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n") ||
					task.projection?.text ||
					task.error ||
					(isTaskTerminal(task.status) ? "No saved output." : "No output yet.");
				output.setText(
					theme.fg("toolOutput", cleanTaskText(read?.text || text)) +
						(task.resultTruncated ? "\n[Saved result truncated.]" : ""),
				);
			},
		};
	},
};

export const fallbackLogTaskView: TaskViewProvider = { ...fallbackTaskView, outputMode: "tail" };
