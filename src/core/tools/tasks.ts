import { renderTasksCall, renderTasksResult, type TasksRenderState } from "../../modes/interactive/tasks/render.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { boundedText, runKill, runList, runRead, runWait } from "./tasks/actions.ts";
import { TASKS_PROMPT_GUIDELINES, TASKS_PROMPT_SNIPPET, TASKS_TOOL_DESCRIPTION, tasksSchema } from "./tasks/schema.ts";
import type { TasksDetails } from "./tasks/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export function createTasksToolDefinition(
	onWaitResult?: (toolCallId: string, taskId: string) => void,
): ToolDefinition<typeof tasksSchema, TasksDetails, TasksRenderState> {
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
						return await runWait(ctx.tasks, params, signal, (taskId) => onWaitResult?.(_id, taskId));
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

export function createTasksTool() {
	return wrapToolDefinition(createTasksToolDefinition());
}
