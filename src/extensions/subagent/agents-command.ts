import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { discoverAgents } from "./agents.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { displayAgentName } from "./display-name.ts";
import { loadSubagentConfig, updateProfileOverride } from "./settings.ts";
import type { AgentDefinition, AgentDiagnostic, SubagentProfileOverride } from "./types.ts";
import { ProfileEditorComponent, type ProfileEditorResult } from "./ui/profile-editor.ts";
import { ProfilePickerComponent, type ProfilePickerResult } from "./ui/profile-picker.ts";

const MODEL_REFRESH_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_REFRESH_ERROR_LENGTH = 240;

function compareAgentNames(left: AgentDefinition, right: AgentDefinition): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function modelId(model: Pick<Model<Api>, "provider" | "id"> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

function findModel(models: readonly Model<Api>[], value: string | undefined): Model<Api> | undefined {
	if (!value) return undefined;
	return models.find((model) => `${model.provider}/${model.id}` === value);
}

function boundText(value: string, limit: number): string {
	const characters = [...value];
	return characters.length <= limit ? value : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function formatDiagnostics(diagnostics: readonly AgentDiagnostic[]): string {
	const visible = diagnostics
		.slice(0, MAX_DIAGNOSTICS)
		.map((diagnostic) => boundText(`${diagnostic.path}: ${diagnostic.message}`, MAX_DIAGNOSTIC_LENGTH));
	if (diagnostics.length > visible.length) {
		visible.push(
			`… ${diagnostics.length - visible.length} more issue${diagnostics.length - visible.length === 1 ? "" : "s"}`,
		);
	}
	return visible.join("\n");
}

function overridesEqual(override: SubagentProfileOverride | undefined, result: ProfileEditorResult): boolean {
	return override?.model === result.model && override?.thinking === result.thinking;
}

async function saveProfileResult(
	ctx: ExtensionCommandContext,
	profileName: string,
	override: SubagentProfileOverride | undefined,
	result: ProfileEditorResult,
): Promise<void> {
	if (overridesEqual(override, result)) return;
	try {
		await updateProfileOverride(profileName, { model: result.model, thinking: result.thinking }, getAgentDir());
	} catch (error) {
		ctx.ui.notify(
			`Could not save ${displayAgentName(profileName)} settings: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

function refreshFailureMessage(providerIds: readonly string[]): string {
	if (providerIds.length === 1) return `Could not refresh ${providerIds[0]}; showing cached models.`;
	const visible = providerIds.slice(0, 3);
	const omitted = providerIds.length - visible.length;
	const suffix = omitted > 0 ? `, +${omitted} more` : "";
	return `Could not refresh ${providerIds.length} model catalogs (${visible.join(", ")}${suffix}); showing cached models.`;
}

async function refreshEditorModels(ctx: ExtensionCommandContext, editor: ProfileEditorComponent): Promise<void> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		editor.cancelRefresh();
	}, MODEL_REFRESH_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const result = await ctx.modelRegistry.refresh({ signal: editor.refreshSignal });
		if (editor.refreshSignal.aborted && !timedOut) return;
		editor.updateModels(ctx.modelRegistry.getAvailable());
		if (result.aborted && timedOut) {
			editor.setRefreshStatus("Model refresh timed out; showing cached models.", "error");
			return;
		}
		const providerIds = [...result.errors.keys()];
		if (providerIds.length > 0) {
			editor.setRefreshStatus(refreshFailureMessage(providerIds), "error");
			return;
		}
		const registryError = ctx.modelRegistry.getError();
		if (registryError) {
			editor.setRefreshStatus(boundText(registryError, MAX_REFRESH_ERROR_LENGTH), "error");
			return;
		}
		editor.setRefreshStatus("Model catalogs refreshed.", "success");
	} catch (error) {
		if (editor.refreshSignal.aborted && !timedOut) return;
		const message = timedOut
			? "Model refresh timed out; showing cached models."
			: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
		editor.setRefreshStatus(boundText(message, MAX_REFRESH_ERROR_LENGTH), "error");
	} finally {
		clearTimeout(timeout);
	}
}

async function showTuiAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	const agentDir = getAgentDir();
	let selectedProfileName: string | undefined;
	while (true) {
		const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
		const picked = await ctx.ui.custom<ProfilePickerResult>(
			(_tui, theme, keybindings, done) =>
				new ProfilePickerComponent(
					theme,
					keybindings,
					discovery.agents,
					discovery.diagnostics,
					done,
					selectedProfileName,
				),
		);
		if (!picked) return;
		if (picked.kind === "diagnostics") {
			ctx.ui.notify(formatDiagnostics(discovery.diagnostics), "warning");
			continue;
		}

		selectedProfileName = picked.name;
		const agent = discovery.agents.find((candidate) => candidate.name === picked.name);
		if (!agent) continue;
		const config = await loadSubagentConfig(agentDir);
		const override = config.profiles[agent.name];
		const edited = await ctx.ui.custom<ProfileEditorResult | undefined>((tui, theme, keybindings, done) => {
			const editor = new ProfileEditorComponent({
				tui,
				theme,
				keybindings,
				agent,
				override,
				models: ctx.modelRegistry.getAvailable(),
				scopedModels: ctx.scopedModels,
				currentSessionModel: ctx.model,
				currentThinking,
				onDone: done,
			});
			editor.setRefreshStatus("Refreshing model catalogs…");
			void refreshEditorModels(ctx, editor);
			return editor;
		});
		if (!edited) continue;
		await saveProfileResult(ctx, agent.name, override, edited);
	}
}

function uniqueProfileLabels(agents: readonly AgentDefinition[]): Map<string, AgentDefinition> {
	const sorted = [...agents].sort(compareAgentNames);
	const counts = new Map<string, number>();
	for (const agent of sorted) {
		const display = displayAgentName(agent.name);
		counts.set(display, (counts.get(display) ?? 0) + 1);
	}
	return new Map(
		sorted.map((agent) => {
			const display = displayAgentName(agent.name);
			return [counts.get(display) === 1 ? display : `${display} (${agent.name})`, agent];
		}),
	);
}

async function showDialogAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	const agentDir = getAgentDir();
	while (true) {
		const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted(), agentDir });
		const labels = uniqueProfileLabels(discovery.agents);
		const diagnosticsLabel = discovery.diagnostics.length
			? `View ${discovery.diagnostics.length} agent file issue${discovery.diagnostics.length === 1 ? "" : "s"}`
			: undefined;
		const selectedLabel = await ctx.ui.select("Agents", [
			...labels.keys(),
			...(diagnosticsLabel ? [diagnosticsLabel] : []),
		]);
		if (!selectedLabel) return;
		if (selectedLabel === diagnosticsLabel) {
			ctx.ui.notify(formatDiagnostics(discovery.diagnostics), "warning");
			continue;
		}
		const agent = labels.get(selectedLabel);
		if (!agent) continue;

		const config = await loadSubagentConfig(agentDir);
		const override = config.profiles[agent.name];
		const models = ctx.modelRegistry.getAvailable().sort((left, right) => {
			const provider = left.provider.localeCompare(right.provider);
			return provider !== 0 ? provider : left.id.localeCompare(right.id);
		});
		const modelChoices = new Map<string, string | undefined>();
		const inheritModelLabel = `inherit (${modelId(ctx.model)})${override?.model ? "" : " ✓"}`;
		modelChoices.set(inheritModelLabel, undefined);
		if (override?.model && !findModel(models, override.model)) {
			modelChoices.set(`${override.model} [unavailable] ✓`, override.model);
		}
		for (const model of models) {
			const id = modelId(model);
			modelChoices.set(`${id}${override?.model === id ? " ✓" : ""}`, id);
		}
		const selectedModelLabel = await ctx.ui.select(`Model for ${displayAgentName(agent.name)}`, [
			...modelChoices.keys(),
		]);
		if (!selectedModelLabel) continue;
		const selectedModelId = modelChoices.get(selectedModelLabel);
		const effectiveModel = selectedModelId ? findModel(models, selectedModelId) : ctx.model;
		const levels = effectiveModel
			? (getSupportedThinkingLevels(effectiveModel) as ThinkingLevel[])
			: [...THINKING_LEVELS];
		const inheritedThinking = effectiveModel
			? (clampThinkingLevel(effectiveModel, currentThinking) as ThinkingLevel)
			: currentThinking;
		const thinkingChoices = new Map<string, ThinkingLevel | undefined>();
		thinkingChoices.set(`inherit (${inheritedThinking})${override?.thinking ? "" : " ✓"}`, undefined);
		for (const level of levels) {
			thinkingChoices.set(`${level}${override?.thinking === level ? " ✓" : ""}`, level);
		}
		const selectedThinkingLabel = await ctx.ui.select(`Thinking for ${displayAgentName(agent.name)}`, [
			...thinkingChoices.keys(),
		]);
		if (!selectedThinkingLabel) continue;
		await saveProfileResult(ctx, agent.name, override, {
			model: selectedModelId,
			thinking: thinkingChoices.get(selectedThinkingLabel),
		});
	}
}

export async function showAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents requires an interactive UI.", "warning");
		return;
	}
	if (ctx.mode === "tui") await showTuiAgentsCommand(ctx, currentThinking);
	else await showDialogAgentsCommand(ctx, currentThinking);
}
