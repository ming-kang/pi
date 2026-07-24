import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
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
import { type PickerItem, SearchPickerComponent } from "./picker.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { ParentModelContext } from "./resolve.ts";
import { ConcurrencyGate, runSubagentInvocation, statusSummary } from "./runner.ts";
import { SubagentParamsSchema } from "./schema.ts";
import { loadSubagentConfig, resetProfileOverrides, updateProfileOverride } from "./settings.ts";
import type { AgentDefinition, SubagentDetails, SubagentProfileOverride } from "./types.ts";

function formatParentModel(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

// Settings resolve in two layers: a saved override wins, otherwise the
// profile inherits the parent session. Inherited rows show the value
// currently in effect so the menu doubles as a status view.
function effectiveSettings(
	override: SubagentProfileOverride | undefined,
	ctx: ExtensionCommandContext,
	parentThinking: string,
): { model: string; thinking: string } {
	return {
		model: override?.model ?? `inherit (${formatParentModel(ctx.model)})`,
		thinking: override?.thinking ?? `inherit (${parentThinking})`,
	};
}

// The thinking picker lists what the effective model actually supports;
// if the saved override names a model that is unavailable right now,
// every level shows and the runtime clamp decides.
function effectiveModelFor(
	ctx: ExtensionCommandContext,
	override: SubagentProfileOverride | undefined,
): Model<Api> | undefined {
	if (override?.model) {
		const separator = override.model.indexOf("/");
		if (separator <= 0) return undefined;
		return ctx.modelRegistry.find(override.model.slice(0, separator), override.model.slice(separator + 1));
	}
	return ctx.model;
}

async function pickModel(
	ctx: ExtensionCommandContext,
	profileName: string,
	override: SubagentProfileOverride | undefined,
): Promise<void> {
	const items: PickerItem<string | null>[] = [
		{
			value: null,
			label: "inherit",
			detail: `Follow the parent session (${formatParentModel(ctx.model)})`,
			current: !override?.model,
		},
		...ctx.modelRegistry.getAvailable().map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${model.provider}/${model.id}`,
			detail: model.name && model.name !== model.id ? model.name : undefined,
			current: override?.model === `${model.provider}/${model.id}`,
		})),
	];
	const selected = await ctx.ui.custom<string | null | undefined>(
		(_tui, theme, _keybindings, done) => new SearchPickerComponent(theme, `Model for ${profileName}`, items, done),
	);
	if (selected === undefined) return;
	await updateProfileOverride(profileName, { model: selected ?? undefined }, getAgentDir());
}

async function pickThinking(
	ctx: ExtensionCommandContext,
	profileName: string,
	override: SubagentProfileOverride | undefined,
	parentThinking: string,
): Promise<void> {
	const model = effectiveModelFor(ctx, override);
	const levels = model ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : [...THINKING_LEVELS];
	const items: PickerItem<ThinkingLevel | null>[] = [
		{
			value: null,
			label: "inherit",
			detail: `Follow the parent session (${parentThinking})`,
			current: !override?.thinking,
		},
		...levels.map((level) => ({ value: level, label: level, current: override?.thinking === level })),
	];
	const selected = await ctx.ui.custom<ThinkingLevel | null | undefined>(
		(_tui, theme, _keybindings, done) => new SearchPickerComponent(theme, `Thinking for ${profileName}`, items, done),
	);
	if (selected === undefined) return;
	await updateProfileOverride(profileName, { thinking: selected ?? undefined }, getAgentDir());
}

async function configureProfile(
	ctx: ExtensionCommandContext,
	agent: AgentDefinition,
	parentThinking: string,
): Promise<void> {
	const agentDir = getAgentDir();
	while (true) {
		const config = await loadSubagentConfig(agentDir);
		const override = config.profiles[agent.name];
		const effective = effectiveSettings(override, ctx, parentThinking);
		const action = await ctx.ui.select(`${agent.name} — ${agent.description}`, [
			`Model: ${effective.model}`,
			`Thinking: ${effective.thinking}`,
			"Back",
		]);
		if (!action || action === "Back") return;
		if (action.startsWith("Model:")) {
			await pickModel(ctx, agent.name, override);
			continue;
		}
		await pickThinking(ctx, agent.name, override, parentThinking);
	}
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

async function showAgentsCommand(ctx: ExtensionCommandContext, parentThinking: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents requires an interactive UI.", "warning");
		return;
	}
	const agentDir = getAgentDir();
	const reset = "Reset all overrides";
	const done = "Done";
	while (true) {
		const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
		const config = await loadSubagentConfig(agentDir);
		const rows = discovery.agents.map((agent) => {
			const effective = effectiveSettings(config.profiles[agent.name], ctx, parentThinking);
			return `${agent.name} — model: ${effective.model} · thinking: ${effective.thinking}`;
		});
		const issueCount = discovery.diagnostics.length;
		const issues = issueCount ? [`Show ${issueCount} agent file issue${issueCount === 1 ? "" : "s"}`] : [];
		const action = await ctx.ui.select("Subagent profiles — select one to configure", [
			...rows,
			...issues,
			reset,
			done,
		]);
		if (!action || action === done) return;
		if (action === reset) {
			const confirmed = await ctx.ui.confirm(
				"Reset profile overrides?",
				"Clear every saved Subagent model and thinking override?",
			);
			if (confirmed) {
				await resetProfileOverrides(agentDir);
				ctx.ui.notify("All profiles now inherit the parent session.", "info");
			}
			continue;
		}
		if (issues.length > 0 && action === issues[0]) {
			ctx.ui.notify(
				discovery.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"),
				"warning",
			);
			continue;
		}
		const agent = discovery.agents.find((candidate) => action.startsWith(`${candidate.name} — `));
		if (agent) await configureProfile(ctx, agent, parentThinking);
	}
}

export default function subagent(pi: ExtensionAPI): void {
	const gate = new ConcurrencyGate();
	const activeAborters = new Set<() => Promise<void>>();
	const syncedProviderIds = new Set<string>();
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
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir: getAgentDir() });
			const runtime = await getModelRuntime(ctx);
			const parent: ParentModelContext = {
				model: ctx.model,
				thinking: pi.getThinkingLevel(),
				modelRegistry: ctx.modelRegistry,
			};
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
			return renderSubagentResult(result, options, theme, context.isError);
		},
	});

	pi.registerCommand(SUBAGENT_COMMAND_NAME, {
		description: "Configure Subagent profiles, models, and thinking levels",
		handler: async (_args, ctx) => showAgentsCommand(ctx, pi.getThinkingLevel()),
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.status === "failed" || details?.status === "aborted") return { isError: true };
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...activeAborters].map((abort) => abort()));
		activeAborters.clear();
	});
}
