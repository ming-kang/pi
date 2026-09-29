import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { createTasksToolDefinition } from "../src/core/tools/tasks.ts";
import { bindTasksUI, type TasksUI } from "../src/modes/interactive/tasks/index.ts";

/** Drives the native tool and UI with the existing test event fixtures. */
export function createTasksHarness(): (host: ExtensionAPI) => void {
	return (host) => {
		let ui: TasksUI | undefined;
		const bind = (ctx: ExtensionContext) => {
			ui?.dispose();
			ui = bindTasksUI(ctx);
		};
		host.on("session_start", (_event, ctx) => bind(ctx));
		host.on("session_shutdown", () => ui?.dispose());
		host.registerTool(createTasksToolDefinition());
		host.registerCommand("tasks", {
			description: "Tasks test driver",
			handler: async (_args, ctx) => {
				if (!ui) bind(ctx);
				await ui!.open();
			},
		});
	};
}
