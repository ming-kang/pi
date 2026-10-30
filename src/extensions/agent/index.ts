import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { clipText } from "./activity.ts";
import { agentRenderers } from "./render.ts";
import { AgentGate, runAgent } from "./runner.ts";
import { openAgentSettings, resolveAgentConfiguration } from "./settings.ts";
import type { AgentActivity, AgentToolDetails } from "./types.ts";

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

export function createAgentTool(gate = new AgentGate()): ToolDefinition<typeof agentSchema, AgentToolDetails> {
	return defineTool({
		name: "Agent",
		label: "Agent",
		description:
			"Delegate independent work to a temporary isolated Agent when separate context or parallel execution offers a clear benefit. Use sparingly; handle known-path reads and small edits directly. The Agent cannot see the parent conversation, so include all necessary context and desired verification in prompt. Foreground returns the final report; background returns a task ID and delivers it automatically. Running Agents publish readable text, can push explicit messages, and accept tasks steer guidance.",
		promptSnippet: "Delegate an independent task",
		promptGuidelines: [
			"Give Agent a complete, self-contained briefing with relevant paths, constraints and expected verification; use parallel calls only for independent, non-overlapping work.",
		],
		parameters: agentSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.prompt.trim() || Buffer.byteLength(params.prompt) > 16 * 1024)
				throw new Error("Agent prompt must contain text and fit within 16 KiB.");
			const { model, thinking } = resolveAgentConfiguration(ctx);
			const auth = await ctx.modelRuntime.getAuth(model, { signal });
			if (!auth) throw new Error(`No authentication for Agent model ${model.provider}/${model.id}`);
			const title = clipText((params.description?.trim() || params.prompt).replace(/\s+/gu, " ").trim(), 160);
			const modelName = `${model.provider}/${model.id}`;
			const info = [
				"Agent",
				`Model     ${modelName}`,
				`Thinking  ${thinking}`,
				`Directory ${ctx.cwd}`,
				"",
				"Prompt",
				params.prompt,
			].join("\n");
			let activities: AgentActivity[] = [];
			const outcome = await ctx.tasks.execute<AgentToolDetails>({
				kind: "agent",
				title,
				toolCallId,
				cwd: ctx.cwd,
				info,
				background: params.background,
				signal,
				onUpdate: (result) => {
					activities = result.details?.activities ?? activities;
					onUpdate?.(result);
				},
				run: (control) =>
					runAgent(
						control,
						{
							prompt: params.prompt,
							cwd: ctx.cwd,
							model,
							thinking,
							modelRuntime: ctx.modelRuntime,
							projectTrusted: ctx.isProjectTrusted(),
						},
						gate,
					),
			});
			if (outcome.kind === "result") return outcome.result;
			return {
				content: [
					{
						type: "text" as const,
						text: `Agent running in background: ${outcome.task.id}. The report will be delivered automatically. Use tasks read/wait/steer/kill to read text, wait, guide or stop.`,
					},
				],
				details: {
					version: 1,
					taskId: outcome.task.id,
					status: "background",
					model: modelName,
					thinking,
					activities,
				},
			};
		},
		...agentRenderers,
	});
}

export default function agentExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAgentTool());
	pi.registerCommand("agent", {
		description: "Choose the model and thinking level for future Agents",
		handler: async (_args, ctx) => openAgentSettings(ctx),
	});
}
