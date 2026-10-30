import type { ToolDefinition } from "../../core/extensions/types.ts";
import { boundedText, runKill, runList, runRead, runSteer, runWait } from "./tool/actions.ts";
import { TASKS_PROMPT_GUIDELINES, TASKS_PROMPT_SNIPPET, TASKS_TOOL_DESCRIPTION, tasksSchema } from "./tool/schema.ts";
import type { TasksDetails } from "./tool/types.ts";
import { renderTasksCall, renderTasksResult, type TasksRenderState } from "./ui/render.ts";

export function createTasksToolDefinition(): ToolDefinition<typeof tasksSchema, TasksDetails, TasksRenderState> {
	return {
		name: "tasks",
		label: "tasks",
		description: TASKS_TOOL_DESCRIPTION,
		promptSnippet: TASKS_PROMPT_SNIPPET,
		promptGuidelines: TASKS_PROMPT_GUIDELINES,
		parameters: tasksSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "read":
						return await runRead(ctx.tasks, params);
					case "wait":
						return await runWait(
							ctx.tasks,
							params,
							signal,
							(taskId) => ctx.tasks.session?.prepareWait(_id, taskId),
							ctx.tasks.session?.waitInterruptSignal,
						);
					case "steer":
						return await runSteer(ctx.tasks, params);
					case "kill":
						return runKill(ctx.tasks, params);
					case "list":
						return runList(ctx.tasks);
				}
			} catch (error) {
				// Lookup failures already carry the current task list from actions.ts.
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(boundedText(message));
			}
		},
		renderCall: renderTasksCall,
		renderResult: renderTasksResult,
	};
}
