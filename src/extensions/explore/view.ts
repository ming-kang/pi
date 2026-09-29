import { Container, Markdown, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { isTaskTerminal } from "../../core/tasks/types.ts";
import type { TaskViewProvider } from "../../core/tasks/view.ts";
import { getMarkdownTheme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export const exploreTaskView: TaskViewProvider = {
	outputMode: "snapshot",
	create({ theme }) {
		const info = new Text("", 0, 0);
		const output = new Container();
		const clean = (value: string) => sanitizeBinaryOutput(stripTerminalSequences(value));
		return {
			info,
			output,
			update(task) {
				const data = task.viewData?.version === 1 ? task.viewData.data : undefined;
				const fields: Record<string, unknown> =
					data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
				const query = typeof fields.query === "string" ? fields.query : task.title;
				info.setText(
					[
						theme.fg("accent", "Explore"),
						`Question  ${clean(query)}`,
						...(["path", "model", "thinking"] as const).flatMap((key) =>
							typeof fields[key] === "string"
								? [
										`${key === "path" ? "Scope" : key === "model" ? "Model" : "Thinking"}  ${clean(fields[key])}`,
									]
								: [],
						),
					].join("\n"),
				);
				output.clear();
				if (!isTaskTerminal(task.status) && Array.isArray(fields.activities)) {
					output.addChild(
						new Text(
							theme.fg(
								"dim",
								fields.activities
									.filter((item) => typeof item === "string")
									.map((item) => clean(String(item)))
									.join("\n"),
							),
							0,
							0,
						),
					);
				}
				const report =
					typeof fields.report === "string"
						? fields.report
						: task.result?.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n");
				if (report) output.addChild(new Markdown(clean(report), 0, 0, getMarkdownTheme()));
				else
					output.addChild(
						new Text(
							theme.fg("dim", isTaskTerminal(task.status) ? "No report returned." : "Preparing investigation…"),
							0,
							0,
						),
					);
			},
		};
	},
};
