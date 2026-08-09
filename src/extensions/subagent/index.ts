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
	ToolRenderContext,
} from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { emptyUsage } from "./activity.ts";
import { discoverAgents, subagentToolDescription } from "./agents.ts";
import { SUBAGENT_COMMAND_NAME, SUBAGENT_TOOL_LABEL, SUBAGENT_TOOL_NAME, THINKING_LEVELS } from "./constants.ts";
import { type PickerItem, SearchPickerComponent } from "./picker.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { ParentModelContext } from "./resolve.ts";
import { ConcurrencyGate, isSubagentError, runSubagentInvocation, statusSummary } from "./runner.ts";
import { SubagentParamsSchema } from "./schema.ts";
import { loadSubagentConfig, resetProfileOverrides, updateProfileOverride } from "./settings.ts";
import type { AgentDefinition, AgentDiscoveryResult, SubagentDetails, SubagentProfileOverride } from "./types.ts";

function formatParentModel(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

interface SubagentRenderState {
	refreshTimer?: ReturnType<typeof setTimeout>;
}

// Re-render live elapsed time and activity tails once per second while the
// result is still partial; the first settled render clears the timer.
function scheduleLiveRefresh(context: ToolRenderContext<SubagentRenderState>, isPartial: boolean): void {
	const state = context.state;
	if (isPartial) {
		if (state.refreshTimer === undefined) {
			state.refreshTimer = setTimeout(() => {
				state.refreshTimer = undefined;
				context.invalidate();
			}, 1000);
			state.refreshTimer.unref?.();
		}
		return;
	}
	if (state.refreshTimer !== undefined) {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = undefined;
	}
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

// Parent tool calls execute in parallel by default, so every sync targeting
// the same child runtime must observe and update the tracking state in order.
const providerSyncQueues = new WeakMap<ModelRuntime, Promise<void>>();

// Provider configs are mostly JSON data, but stream, refresh, and OAuth hooks
// are functions whose identity is behaviorally significant. Compare enumerable
// values recursively so callback-only re-registrations propagate as well.
function providerConfigValuesEqual(
	left: unknown,
	right: unknown,
	seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;

	const comparedRights = seen.get(left);
	if (comparedRights?.has(right)) return true;
	if (comparedRights) comparedRights.add(right);
	else seen.set(left, new WeakSet([right]));

	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	if (leftKeys.length !== rightKeys.length) return false;
	for (let index = 0; index < leftKeys.length; index++) {
		const key = leftKeys[index];
		if (key === undefined || key !== rightKeys[index]) return false;
		if (!providerConfigValuesEqual(leftRecord[key], rightRecord[key], seen)) return false;
	}
	return true;
}

async function syncParentProvidersNow(
	runtime: ModelRuntime,
	registry: ModelRegistry,
	syncedIds: Set<string>,
	syncedApiKeys: Map<string, string>,
): Promise<void> {
	const nextIds = new Set(registry.getRegisteredProviderIds());
	for (const id of [...syncedIds]) {
		if (!nextIds.has(id)) {
			runtime.unregisterProvider(id);
			if (syncedApiKeys.has(id)) {
				await runtime.removeRuntimeApiKey(id);
				syncedApiKeys.delete(id);
			}
			syncedIds.delete(id);
		}
	}
	for (const id of nextIds) {
		const native = registry.getRegisteredNativeProvider(id);
		if (native) {
			if (runtime.getRegisteredNativeProvider(id) !== native) runtime.registerNativeProvider(native);
		} else {
			const config = registry.getRegisteredProviderConfig(id);
			if (config && !providerConfigValuesEqual(runtime.getRegisteredProviderConfig(id), config)) {
				runtime.registerProvider(id, config);
			}
		}
		// Record the provider as soon as its registration is known to be in the
		// child runtime. If auth lookup then fails, a later removal can still
		// clean up this partially synchronized provider.
		syncedIds.add(id);
		const auth = await registry.getProviderAuth(id);
		const apiKey = auth?.auth.apiKey;
		if (apiKey && syncedApiKeys.get(id) !== apiKey) {
			// pi-ai 0.84 AuthOperationOptions carries only signal; the runtime's
			// credential sync hardcodes allowNetwork: false.
			await runtime.setRuntimeApiKey(id, apiKey);
			syncedApiKeys.set(id, apiKey);
		} else if (!apiKey && syncedApiKeys.has(id)) {
			await runtime.removeRuntimeApiKey(id);
			syncedApiKeys.delete(id);
		}
	}
}

export async function syncParentProviders(
	runtime: ModelRuntime,
	registry: ModelRegistry,
	syncedIds: Set<string>,
	syncedApiKeys: Map<string, string>,
): Promise<void> {
	const previous = providerSyncQueues.get(runtime) ?? Promise.resolve();
	const current = previous
		.catch(() => undefined)
		.then(() => syncParentProvidersNow(runtime, registry, syncedIds, syncedApiKeys));
	providerSyncQueues.set(runtime, current);
	try {
		await current;
	} finally {
		if (providerSyncQueues.get(runtime) === current) providerSyncQueues.delete(runtime);
	}
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
	const syncedProviderApiKeys = new Map<string, string>();
	let modelRuntimePromise: Promise<ModelRuntime> | undefined;

	const getModelRuntime = async (ctx: ExtensionContext): Promise<ModelRuntime> => {
		if (!modelRuntimePromise) {
			const agentDir = getAgentDir();
			const created = ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			});
			// A transient failure (network, filesystem) must not brick the tool
			// for the rest of the session: drop the rejected promise so the
			// next invocation retries creation.
			created.catch(() => {
				if (modelRuntimePromise === created) modelRuntimePromise = undefined;
			});
			modelRuntimePromise = created;
		}
		const runtime = await modelRuntimePromise;
		await syncParentProviders(runtime, ctx.modelRegistry, syncedProviderIds, syncedProviderApiKeys);
		return runtime;
	};

	const registerSubagentTool = (discovery: AgentDiscoveryResult): void => {
		pi.registerTool<typeof SubagentParamsSchema, SubagentDetails, SubagentRenderState>({
			name: SUBAGENT_TOOL_NAME,
			label: SUBAGENT_TOOL_LABEL,
			description: subagentToolDescription(discovery),
			promptSnippet: "Delegate focused research, review, or implementation tasks to isolated subagents",
			promptGuidelines: [
				"Use subagent when a bounded task benefits from isolated context or parallel investigation; choose a profile and write its briefing using the tool description.",
			],
			parameters: SubagentParamsSchema,
			async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
				// First paint before any await: model-runtime creation and task
				// resolution can stall on first use (network, filesystem), and
				// the transcript card must not sit empty while they do.
				onUpdate?.({
					content: [{ type: "text", text: "Initializing…" }],
					details: {
						mode: params.tasks ? "parallel" : "single",
						status: "running",
						runs: [],
						startedAt: Date.now(),
						usage: emptyUsage(),
					},
				});
				const discovery = discoverAgents(ctx.cwd, {
					projectTrusted: ctx.isProjectTrusted(),
					agentDir: getAgentDir(),
				});
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
					projectTrusted: ctx.isProjectTrusted(),
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
				scheduleLiveRefresh(context, options.isPartial);
				return renderSubagentResult(result, options, theme, context.isError);
			},
		});
	};

	registerSubagentTool(discoverAgents(process.cwd(), { projectTrusted: false, agentDir: getAgentDir() }));
	pi.on("session_start", (_event, ctx) => {
		registerSubagentTool(
			discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir: getAgentDir() }),
		);
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
