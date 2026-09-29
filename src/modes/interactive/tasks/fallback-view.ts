import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { TaskViewProvider } from "../../../core/tasks/view.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";

/** Saved text remains readable even when its renderer is unavailable. */
export const fallbackTaskView: TaskViewProvider = {
	outputMode: "snapshot",
	create({ theme }) {
		const info = new Text("", 0, 0);
		const output = new Text("", 0, 0);
		return {
			info,
			output,
			update(task) {
				info.setText(sanitizeBinaryOutput(stripTerminalSequences(`${task.kind}\n${task.command ?? task.title}`)));
				const text =
					task.result?.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n") ||
					task.projection?.text ||
					task.error ||
					"No output yet.";
				output.setText(
					theme.fg("toolOutput", sanitizeBinaryOutput(stripTerminalSequences(text))) +
						(task.resultTruncated ? "\n[Saved result truncated.]" : ""),
				);
			},
		};
	},
};
