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
			description:
				"Complete, self-contained task briefing: goal, relevant context and paths, constraints, whether to edit or only investigate, and expected verification and report. The Agent cannot see this conversation.",
		}),
		description: Type.Optional(
			Type.String({ description: "Short (3–5 word) task label for the transcript and Tasks panel" }),
		),
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
			"Run one self-contained task in a fresh Agent session and get back only its final report. Use Agent when separate context or parallel execution clearly helps; handle known-path reads and small edits directly. The Agent cannot see this conversation, but shares your working directory and applicable project instructions, with read, bash, edit, and write. Foreground returns the report; background returns a task ID and delivers the report automatically.",
		promptSnippet: "Delegate a self-contained task and receive only its final report",
		promptGuidelines: [
			"Use Agent primarily for independent research, verification, or well-specified, self-contained implementation when separate context or parallel execution clearly helps. Keep design and substantial coding in the main session; handle known-path reads and small edits directly. “Multiple angles” or “be thorough” alone does not justify an Agent.",
			"Give Agent a self-contained briefing: the goal and why it matters, prior findings or ruled-out options, relevant paths and constraints, whether to investigate or edit, and expected verification. For open investigations, hand over the question rather than a fragile step-by-step procedure; state any report-length limit.",
			"Keep ownership of synthesis when using Agent—never delegate understanding. For edits, supply your conclusions, target behavior, relevant files, and acceptance checks rather than “based on your findings, fix it.” Verify actual edits and test evidence before calling the work done.",
			"Run parallel Agents only on independent work; concurrent writers must not touch the same files or shared state. Do not duplicate delegated work or repeatedly poll a background Agent. Continue independent work, or wait when its result is needed.",
			"An Agent report is not automatically presented to the user. Relay the important outcome, verification result, and remaining risks concisely.",
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
