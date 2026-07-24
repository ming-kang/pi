import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { discoverAgents } from "./agents.ts";
import { SUBAGENT_COMMAND_NAME, SUBAGENT_TOOL_LABEL, SUBAGENT_TOOL_NAME, THINKING_LEVELS } from "./constants.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { ParentModelContext } from "./resolve.ts";
import { ConcurrencyGate, runSubagentInvocation, statusSummary } from "./runner.ts";
import { SubagentParamsSchema } from "./schema.ts";
import { loadSubagentConfig, resetProfileOverrides, updateProfileOverride } from "./settings.ts";
import type { AgentDefinition, SubagentDetails } from "./types.ts";
import { SubagentWidget } from "./widget.ts";

function modelName(model: { provider: string; id: string; name?: string }): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`;
}

function describeProfile(
	agent: AgentDefinition,
	override: Awaited<ReturnType<typeof loadSubagentConfig>>["profiles"][string] | undefined,
): string {
	const model = override?.model ?? agent.model ?? "parent";
	const thinking = override?.thinking ?? agent.thinking ?? "parent";
	return [
		`${agent.name} (${agent.source})`,
		agent.description,
		`model: ${model}`,
		`thinking: ${thinking}`,
		`tools: ${agent.tools.join(", ")}`,
		`source: ${agent.filePath}`,
	].join("\n");
}

async function syncParentProviders(
	runtime: ModelRuntime,
	registry: ModelRegistry,
	syncedIds: Set<string>,
): Promise<void> {
	const nextIds = new Set(registry.getRegisteredProviderIds());
	for (const id of syncedIds) {
		if (!nextIds.has(id)) runtime.unregisterProvider(id);
	}
	for (const id of nextIds) {
		const native = registry.getRegisteredNativeProvider(id);
		if (native) runtime.registerNativeProvider(native);
		else {
			const config = registry.getRegisteredProviderConfig(id);
			if (config) runtime.registerProvider(id, config);
		}
		const auth = await registry.getProviderAuth(id);
		if (auth?.auth.apiKey) await runtime.setRuntimeApiKey(id, auth.auth.apiKey, { allowNetwork: false });
	}
	syncedIds.clear();
	for (const id of nextIds) syncedIds.add(id);
}

async function configureProfile(ctx: ExtensionCommandContext, agent: AgentDefinition): Promise<void> {
	const agentDir = getAgentDir();
	const config = await loadSubagentConfig(agentDir);
	const override = config.profiles[agent.name];
	const settings = await ctx.ui.select(`Configure ${agent.name}`, ["Model", "Thinking", "Back"]);
	if (settings === "Model") {
		const choices = [
			"inherit — use parent session model",
			"agent default — clear saved override",
			...ctx.modelRegistry.getAvailable().map((model) => modelName(model)),
		];
		const selected = await ctx.ui.select(`Model for ${agent.name}`, choices);
		if (!selected) return;
		if (selected.startsWith("inherit")) await updateProfileOverride(agent.name, { model: "inherit" }, agentDir);
		else if (selected.startsWith("agent default"))
			await updateProfileOverride(agent.name, { model: undefined }, agentDir);
		else {
			const model = ctx.modelRegistry.getAvailable().find((candidate) => modelName(candidate) === selected);
			if (!model) return;
			await updateProfileOverride(agent.name, { model: `${model.provider}/${model.id}` }, agentDir);
		}
		ctx.ui.notify(`Saved model override for ${agent.name}.`, "info");
		return;
	}
	if (settings === "Thinking") {
		const choices = [
			"inherit — use parent session thinking",
			"agent default — clear saved override",
			...THINKING_LEVELS,
		];
		const selected = await ctx.ui.select(`Thinking for ${agent.name}`, choices);
		if (!selected) return;
		if (selected.startsWith("inherit")) await updateProfileOverride(agent.name, { thinking: "inherit" }, agentDir);
		else if (selected.startsWith("agent default"))
			await updateProfileOverride(agent.name, { thinking: undefined }, agentDir);
		else await updateProfileOverride(agent.name, { thinking: selected as ThinkingLevel }, agentDir);
		ctx.ui.notify(`Saved thinking override for ${agent.name}.`, "info");
		return;
	}
	if (override) ctx.ui.notify(describeProfile(agent, override), "info");
}

async function showAgentsCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents requires an interactive UI.", "warning");
		return;
	}
	const agentDir = getAgentDir();
	const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
	while (true) {
		const action = await ctx.ui.select("Subagent profiles", [
			"Configure profile model / thinking…",
			"Inspect profile definitions…",
			"Reset saved profile overrides…",
			"Done",
		]);
		if (!action || action === "Done") return;
		if (action.startsWith("Configure")) {
			const selected = await ctx.ui.select(
				"Choose a subagent profile",
				discovery.agents.map((agent) => `${agent.name} — ${agent.description}`),
			);
			if (!selected) continue;
			const agent = discovery.agents.find((candidate) => selected.startsWith(`${candidate.name} — `));
			if (agent) await configureProfile(ctx, agent);
			continue;
		}
		if (action.startsWith("Inspect")) {
			const selected = await ctx.ui.select(
				"Inspect subagent profile",
				discovery.agents.map((agent) => `${agent.name} — ${agent.description}`),
			);
			if (!selected) continue;
			const agent = discovery.agents.find((candidate) => selected.startsWith(`${candidate.name} — `));
			if (!agent) continue;
			const config = await loadSubagentConfig(agentDir);
			const diagnostics = discovery.diagnostics
				.filter((diagnostic) => diagnostic.path === agent.filePath)
				.map((diagnostic) => `\nDiagnostic: ${diagnostic.message}`)
				.join("");
			ctx.ui.notify(`${describeProfile(agent, config.profiles[agent.name])}${diagnostics}`, "info");
			continue;
		}
		const confirmed = await ctx.ui.confirm(
			"Reset profile overrides?",
			"Clear every saved Subagent model and thinking override?",
		);
		if (!confirmed) continue;
		await resetProfileOverrides(agentDir);
		ctx.ui.notify("Cleared saved Subagent profile overrides.", "info");
	}
}

export default function subagent(pi: ExtensionAPI): void {
	const gate = new ConcurrencyGate();
	const activeAborters = new Set<() => Promise<void>>();
	const syncedProviderIds = new Set<string>();
	const widget = new SubagentWidget();
	let modelRuntimePromise: Promise<ModelRuntime> | undefined;

	const getModelRuntime = async (ctx: ExtensionContext): Promise<ModelRuntime> => {
		if (!modelRuntimePromise) {
			const agentDir = getAgentDir();
			modelRuntimePromise = ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			});
		}
		const runtime = await modelRuntimePromise;
		await syncParentProviders(runtime, ctx.modelRegistry, syncedProviderIds);
		return runtime;
	};

	pi.registerTool<typeof SubagentParamsSchema, SubagentDetails>({
		name: SUBAGENT_TOOL_NAME,
		label: SUBAGENT_TOOL_LABEL,
		description:
			"Delegate a bounded task to an isolated subagent. Use one of: single prompt, parallel tasks, or sequential chain.",
		promptSnippet: "Delegate focused research, review, or implementation tasks to isolated subagents",
		promptGuidelines: [
			"Use subagent for a focused delegated task when isolated context or parallel investigation will improve the result.",
			"Give every subagent task a concise description and a complete self-contained prompt; subagents cannot see this conversation.",
			"Use one single prompt, a tasks array for independent parallel work, or a chain array for sequential work.",
		],
		parameters: SubagentParamsSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir: getAgentDir() });
			const runtime = await getModelRuntime(ctx);
			const parent: ParentModelContext = {
				model: ctx.model,
				thinking: pi.getThinkingLevel(),
				modelRegistry: ctx.modelRegistry,
			};
			try {
				const execution = await runSubagentInvocation({
					params,
					parentCwd: ctx.cwd,
					agents: discovery.agents,
					parent,
					modelRuntime: runtime,
					agentDir: getAgentDir(),
					configAgentDir: getAgentDir(),
					signal,
					gate,
					onUpdate: (details) => {
						if (ctx.hasUI) widget.update(ctx.ui, toolCallId, details);
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
			} finally {
				widget.finish(toolCallId);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context.isError);
		},
	});

	pi.registerCommand(SUBAGENT_COMMAND_NAME, {
		description: "Configure Subagent profiles, models, and thinking levels",
		handler: async (_args, ctx) => showAgentsCommand(ctx),
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.status === "failed" || details?.status === "aborted") return { isError: true };
	});

	pi.on("session_shutdown", async () => {
		widget.dispose();
		await Promise.allSettled([...activeAborters].map((abort) => abort()));
		activeAborters.clear();
	});
}
