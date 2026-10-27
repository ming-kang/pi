import "./keybindings.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { boundedText, describeTaskLine } from "./tool/actions.ts";
import { createTasksToolDefinition } from "./tool.ts";
import { renderTaskCompletion } from "./ui/completion-render.ts";
import { bindTasksUI, type TasksUI } from "./ui/index.ts";
import { confirmStopBranchTasks } from "./ui/tree.ts";

/** User-facing Tasks management; execution and durable delivery remain session-owned. */
export default function tasksExtension(pi: ExtensionAPI): void {
	let ui: TasksUI | undefined;
	const bind = (ctx: ExtensionContext) => {
		ui?.dispose();
		ui = bindTasksUI(ctx);
	};

	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_shutdown", () => {
		ui?.dispose();
		ui = undefined;
	});
	pi.on("session_before_tree", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const stopped = ctx.tasks.session?.stoppedByTreeNavigation(event.preparation.targetId) ?? [];
		if (!(await confirmStopBranchTasks(stopped, (title, message) => ctx.ui.confirm(title, message))))
			return { cancel: true };
	});

	pi.registerTool(createTasksToolDefinition());
	pi.registerMessageRenderer("task-completion", renderTaskCompletion);
	pi.registerCommand("tasks", {
		description: "View and manage session tasks",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				const tasks = ctx.tasks.list().filter((task) => task.mode === "background");
				ctx.ui.notify(
					boundedText(tasks.slice(0, 10).map(describeTaskLine).join("\n")) || "No background tasks.",
					"info",
				);
				return;
			}
			if (!ui) bind(ctx);
			await ui!.open();
		},
	});
}
