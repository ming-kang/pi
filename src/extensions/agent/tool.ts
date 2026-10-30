import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import type { TaskSnapshot } from "../../core/tasks/types.ts";
import { clipText } from "./activity.ts";
import { agentRenderers } from "./render.ts";
import { resolveAgentConfiguration } from "./settings.ts";
import { AGENT_CONCURRENCY, AGENT_PROMPT_BYTES, type AgentToolDetails } from "./types.ts";
import { runWorker } from "./worker.ts";

const agentSchema = Type.Object(
	{
		prompt: Type.String({
			minLength: 1,
			description: "Complete, self-contained task briefing; the Agent cannot see this conversation",
		}),
		description: Type.Optional(Type.String({ description: "Short task label for the transcript and Tasks panel" })),
		background: Type.Optional(
			Type.Boolean({ description: "Return a task ID and deliver the final report asynchronously" }),
		),
	},
	{ additionalProperties: false },
);

/** The model-facing handoff: who moved the Agent, whether it waits for a slot, and how to follow it. */
function handoffResult(task: TaskSnapshot, byUser: boolean): AgentToolResult<AgentToolDetails> {
	const moved = byUser
		? `The user moved this Agent to the background while it was running: ${task.id}. It continues unchanged.`
		: `Agent running in background: ${task.id}.`;
	const queued = task.status === "queued" ? " It is queued until an Agent slot frees." : "";
	return {
		content: [
			{
				type: "text",
				text: `${moved}${queued} The report will be delivered automatically. Use tasks read/wait/kill to inspect, wait or stop.`,
			},
		],
		details: { version: 2, state: "background", taskId: task.id, byUser },
	};
}

export function createAgentTool(
	options: { concurrency?: number } = {},
): ToolDefinition<typeof agentSchema, AgentToolDetails> {
	const limit = options.concurrency ?? AGENT_CONCURRENCY;
	return defineTool({
		name: "Agent",
		label: "Agent",
		description:
			"Delegate independent work to a temporary isolated Agent when separate context or parallel execution offers a clear benefit. Use sparingly; handle known-path reads and small edits directly. The Agent cannot see the parent conversation, so include all necessary context and desired verification in prompt. Foreground returns the final report; background returns a task ID and delivers it automatically.",
		promptSnippet: "Delegate an independent task",
		promptGuidelines: [
			"Give Agent a complete, self-contained briefing with relevant paths, constraints and expected verification; use parallel calls only for independent, non-overlapping work.",
		],
		parameters: agentSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.prompt.trim() || Buffer.byteLength(params.prompt) > AGENT_PROMPT_BYTES)
				throw new Error("Agent prompt must contain text and fit within 16 KiB.");
			const { model, thinking } = resolveAgentConfiguration(ctx);
			const auth = await ctx.modelRuntime.getAuth(model, { signal });
			if (!auth) throw new Error(`No authentication for Agent model ${model.provider}/${model.id}`);
			const outcome = await ctx.tasks.execute<AgentToolDetails>({
				kind: "agent",
				label: "Agent",
				title: clipText((params.description?.trim() || params.prompt).replace(/\s+/gu, " ").trim(), 160),
				output: "report",
				input: { label: "Prompt", text: params.prompt, truncated: false },
				facts: [
					["Model", `${model.provider}/${model.id}`],
					["Thinking", thinking],
					["Directory", ctx.cwd],
				],
				concurrency: { key: "agent", limit },
				toolCallId,
				background: params.background,
				signal,
				onUpdate,
				run: (control) =>
					runWorker(control, {
						prompt: params.prompt,
						cwd: ctx.cwd,
						model,
						thinking,
						modelRuntime: ctx.modelRuntime,
						projectTrusted: ctx.isProjectTrusted(),
					}),
			});
			if (outcome.kind === "result") return outcome.result;
			return handoffResult(outcome.task, params.background !== true);
		},
		...agentRenderers,
	});
}
