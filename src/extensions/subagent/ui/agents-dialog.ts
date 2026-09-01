import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { AGENT_PROFILE_LABELS, AGENT_PROFILES } from "../agents.ts";
import { loadSubagentConfig, updateProfileOverride } from "../settings.ts";
import type { AgentProfile, SubagentConfigFile, SubagentProfileOverride } from "../types.ts";
import {
	buildModelChoices,
	buildSettingsRows,
	buildThinkingChoices,
	compareModels,
	type SettingsAction,
} from "./choices.ts";

async function persistOverride(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	patch: Partial<SubagentProfileOverride>,
): Promise<SubagentConfigFile | undefined> {
	try {
		return await updateProfileOverride(profile.name, patch, getAgentDir());
	} catch (error) {
		ctx.ui.notify(
			`Could not save ${AGENT_PROFILE_LABELS[profile.name]} settings: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return undefined;
	}
}

async function selectProfile(ctx: ExtensionCommandContext): Promise<AgentProfile | undefined> {
	const labels = AGENT_PROFILES.map((profile) => AGENT_PROFILE_LABELS[profile.name]);
	const label = await ctx.ui.select("Agents", labels);
	return label === undefined
		? undefined
		: AGENT_PROFILES.find((profile) => AGENT_PROFILE_LABELS[profile.name] === label);
}

async function showDialogSettingsMenu(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	override: SubagentProfileOverride | undefined,
	currentThinking: ThinkingLevel,
): Promise<SettingsAction | undefined> {
	const options = new Map<string, SettingsAction>();
	for (const row of buildSettingsRows({
		override,
		models: ctx.modelRegistry.getAvailable(),
		currentSessionModel: ctx.model,
		currentThinking,
	})) {
		options.set(`${row.label} — ${row.value}`, row.action);
	}
	const label = await ctx.ui.select(AGENT_PROFILE_LABELS[profile.name], [...options.keys()]);
	return label === undefined ? undefined : options.get(label);
}

async function showDialogModelPicker(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	override: SubagentProfileOverride | undefined,
): Promise<{ modelId: string | undefined } | undefined> {
	const models = [...ctx.modelRegistry.getAvailable()].sort(compareModels);
	const choices = buildModelChoices({
		models,
		currentSessionModel: ctx.model,
		savedModelId: override?.model,
	});
	const label = await ctx.ui.select(`Model — ${AGENT_PROFILE_LABELS[profile.name]}`, [...choices.keys()]);
	return label === undefined ? undefined : { modelId: choices.get(label) };
}

async function showDialogThinkingPicker(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	override: SubagentProfileOverride | undefined,
	currentThinking: ThinkingLevel,
): Promise<{ level: ThinkingLevel | undefined } | undefined> {
	const choices = buildThinkingChoices({
		currentSessionModel: ctx.model,
		models: ctx.modelRegistry.getAvailable(),
		override,
		currentThinking,
	});
	const label = await ctx.ui.select(`Thinking — ${AGENT_PROFILE_LABELS[profile.name]}`, [...choices.keys()]);
	return label === undefined ? undefined : { level: choices.get(label) };
}

async function runDialogProfileSettings(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	currentThinking: ThinkingLevel,
): Promise<void> {
	const agentDir = getAgentDir();
	while (true) {
		const config = await loadSubagentConfig(agentDir, (message) => ctx.ui.notify(message, "warning"));
		const override = config.profiles[profile.name];
		const action = await showDialogSettingsMenu(ctx, profile, override, currentThinking);
		if (!action) return;
		if (action === "model") {
			const chosen = await showDialogModelPicker(ctx, profile, override);
			if (!chosen) continue;
			await persistOverride(ctx, profile, { model: chosen.modelId });
		} else {
			const chosen = await showDialogThinkingPicker(ctx, profile, override, currentThinking);
			if (!chosen) continue;
			await persistOverride(ctx, profile, { thinking: chosen.level });
		}
	}
}

export async function showDialogAgentsCommand(
	ctx: ExtensionCommandContext,
	currentThinking: ThinkingLevel,
): Promise<void> {
	while (true) {
		const profile = await selectProfile(ctx);
		if (!profile) return;
		await runDialogProfileSettings(ctx, profile, currentThinking);
	}
}
