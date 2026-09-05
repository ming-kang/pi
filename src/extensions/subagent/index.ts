import { getAgentDir } from "../../config.ts";
import type { BackgroundControl, BackgroundProjection, BackgroundTerminalStatus } from "../../core/background/types.ts";
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
import { boundText } from "./text.ts";
import type { SubagentDetails } from "./types.ts";

export default function subagent(pi: ExtensionAPI): void {
	const gate = new ConcurrencyGate();
	let workerOrdinal = 0;
	const activeAborters = new Set<() => Promise<void>>();

	pi.registerTool<typeof SubagentParamsSchema, SubagentDetails, SubagentRenderState>({
		name: SUBAGENT_TOOL_NAME,
		label: SUBAGENT_TOOL_LABEL,
		description: subagentToolDescription(),
		promptSnippet: "Delegate bounded work to isolated explorer or general workers",
		promptGuidelines: [
			"Use `subagent` for bounded work that benefits from isolated context or concurrent investigation; do not delegate a task you can finish with one or two direct tool calls.",
		],
		parameters: SubagentParamsSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			const managed = ctx.background?.enabled || params.background === true;
			if (managed && !ctx.background) throw new Error("Background execution requires an enabled Background host.");
			let latest: SubagentDetails = {
				status: "running",
				runs: [],
				startedAt: Date.now(),
				usage: emptyUsage(),
			};
			const ordinals = new Map<string, number>();
			const projection = (details: SubagentDetails): BackgroundProjection => ({
				text: statusSummary(details),
				workers: details.runs.map((run, index) => {
					let ordinal = ordinals.get(run.id);
					if (ordinal === undefined) {
						ordinal = ++workerOrdinal;
						ordinals.set(run.id, ordinal);
					}
					return {
						id: run.id,
						label: `#${ordinal} ${run.agent}`,
						status: run.status,
						model: boundText(`${run.model} · ${run.thinking}`, 512),
						prompt: boundText(params.tasks[index]?.prompt ?? run.description, 4096),
						activity: boundText(
							run.currentActivity ??
								run.activities
									.slice(-3)
									.map((item) => item.summary)
									.join("\n"),
							1024,
						),
						outcome: boundText(
							[run.error, run.report].filter(Boolean).join("\n\n") ||
								(run.status === "queued" || run.status === "running"
									? "Still running…"
									: "No outcome returned."),
							4096,
						),
						usage: `${run.usage.totalTokens} tokens · $${run.usage.cost.toFixed(4)} · ${run.usage.toolUses} tool calls`,
					};
				}),
			});
			const run = async (
				control?: BackgroundControl<SubagentDetails>,
			): Promise<AgentToolResult<SubagentDetails>> => {
				const update = (details: SubagentDetails): void => {
					latest = details;
					const result: AgentToolResult<SubagentDetails> = {
						content: [{ type: "text", text: statusSummary(details) }],
						details,
					};
					if (control) control.publish(result, projection(details));
					else onUpdate?.(result);
				};
				update(latest);
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
					signal: control?.signal ?? signal,
					gate,
					batchId: control?.id ?? toolCallId,
					onUpdate: update,
					onAccepted: control ? () => control.accept() : undefined,
					onConfigWarning: (message) => ctx.ui.notify(message, "warning"),
					registerAbort: control
						? undefined
						: (abort) => {
								activeAborters.add(abort);
								return () => activeAborters.delete(abort);
							},
				});
				const result: AgentToolResult<SubagentDetails> = {
					content: [{ type: "text", text: execution.content }],
					details: execution.details,
					usage: execution.usage,
				};
				control?.publish(result, projection(execution.details));
				return result;
			};
			if (!managed) return run();
			const outcome = await ctx.background!.execute<SubagentDetails>({
				kind: "subagent",
				title: `Subagent · ${params.tasks.length} tasks`,
				toolCallId,
				background: params.background === true,
				signal,
				onUpdate,
				run: async (control) => {
					const result = await run(control);
					const status = result.details!.status;
					const terminal: BackgroundTerminalStatus =
						status === "aborted" ? "cancelled" : status === "running" ? "failed" : status;
					return { result, status: terminal };
				},
			});
			if (outcome.kind === "result") return outcome.result;
			const submittedAt = Date.now();
			return {
				content: [
					{
						type: "text",
						text: `Subagent invocation handed to background: ${outcome.task.id}. Use bg to read, wait for, or stop the group.`,
					},
				],
				details: { ...latest, endedAt: submittedAt, background: { id: outcome.task.id, submittedAt } },
			};
		},
		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			scheduleLiveRefresh(context, options.isPartial && !result.details?.background);
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
		if (details && !details.background && isSubagentError(details)) return { isError: true };
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...activeAborters].map((abort) => abort()));
		activeAborters.clear();
	});
}
