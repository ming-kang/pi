import type { ToolDefinition } from "../../core/extensions/types.ts";
import { TASKS_TOOL_NAME } from "../../core/tasks/types.ts";
import { boundedText, runKill, runList, runRead } from "./tool/actions.ts";
import { TASKS_PROMPT_GUIDELINES, TASKS_PROMPT_SNIPPET, TASKS_TOOL_DESCRIPTION, tasksSchema } from "./tool/schema.ts";
import type { TasksDetails } from "./tool/types.ts";
import { renderTasksCall, renderTasksResult } from "./ui/render.ts";

export function createTasksToolDefinition(): ToolDefinition<typeof tasksSchema, TasksDetails> {
	return {
		name: TASKS_TOOL_NAME,
		label: TASKS_TOOL_NAME,
		description: TASKS_TOOL_DESCRIPTION,
		promptSnippet: TASKS_PROMPT_SNIPPET,
		promptGuidelines: TASKS_PROMPT_GUIDELINES,
		parameters: tasksSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "read":
						return await runRead(ctx.tasks, params);
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
