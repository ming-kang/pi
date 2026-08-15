import { getAgentDir } from "../../config.ts";
import type { AgentToolResult, ExtensionAPI } from "../../core/extensions/types.ts";
import { emptyUsage } from "./activity.ts";
import { subagentToolDescription } from "./agents.ts";
import { showAgentsCommand } from "./agents-command.ts";
import { SUBAGENT_COMMAND_NAME, SUBAGENT_TOOL_LABEL, SUBAGENT_TOOL_NAME } from "./constants.ts";
import { renderSubagentCall, renderSubagentResult, type SubagentRenderState, scheduleLiveRefresh } from "./render.ts";
import type { ParentModelContext } from "./resolve.ts";
import { ConcurrencyGate, isSubagentError, runSubagentInvocation } from "./runner.ts";
import { SubagentParamsSchema } from "./schema.ts";
import { statusSummary } from "./state.ts";
import type { SubagentDetails } from "./types.ts";

export default function subagent(pi: ExtensionAPI): void {
	const gate = new ConcurrencyGate();
	const activeAborters = new Set<() => Promise<void>>();

	pi.registerTool<typeof SubagentParamsSchema, SubagentDetails, SubagentRenderState>({
		name: SUBAGENT_TOOL_NAME,
		label: SUBAGENT_TOOL_LABEL,
		description: subagentToolDescription(),
		promptSnippet: "Delegate bounded work to isolated Explorer or General workers",
		promptGuidelines: [
			"Use subagent for bounded work that benefits from isolated context or concurrent investigation; default to explorer, and choose general only when the task may modify files or state.",
		],
		parameters: SubagentParamsSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			// First paint before task preflight so filesystem and model checks
			// cannot leave the transcript card empty.
			onUpdate?.({
				content: [{ type: "text", text: "Initializing…" }],
				details: {
					status: "running",
					runs: [],
					startedAt: Date.now(),
					usage: emptyUsage(),
				},
			});
			const parent: ParentModelContext = {
				model: ctx.model,
				thinking: pi.getThinkingLevel(),
				modelRegistry: ctx.modelRegistry,
			};
			const execution = await runSubagentInvocation({
				params,
				parentCwd: ctx.cwd,
				parent,
				modelRuntime: ctx.modelRuntime,
				agentDir: getAgentDir(),
				projectTrusted: ctx.isProjectTrusted(),
				signal,
				gate,
				batchId: toolCallId,
				onUpdate: (details) => {
					onUpdate?.({ content: [{ type: "text", text: statusSummary(details) }], details });
				},
				registerAbort: (abort) => {
					activeAborters.add(abort);
					return () => activeAborters.delete(abort);
				},
			});
			return {
				content: [{ type: "text", text: execution.content }],
				details: execution.details,
				usage: execution.usage,
			};
		},
		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			scheduleLiveRefresh(context, options.isPartial);
			return renderSubagentResult(result, options, theme, context.args, context.isError);
		},
	});

	pi.registerCommand(SUBAGENT_COMMAND_NAME, {
		description: "Configure Subagent profiles, models, and thinking levels",
		handler: async (_args, ctx) => showAgentsCommand(ctx, pi.getThinkingLevel()),
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return;
		const details = event.details as SubagentDetails | undefined;
		if (details && isSubagentError(details)) return { isError: true };
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...activeAborters].map((abort) => abort()));
		activeAborters.clear();
	});
}
