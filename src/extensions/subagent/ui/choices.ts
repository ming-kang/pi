import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { THINKING_LEVELS } from "../constants.ts";
import { effectiveModel, findModel, inheritedThinking, modelId } from "../model-selection.ts";
import type { SubagentProfileOverride } from "../types.ts";

export type SettingsAction = "model" | "thinking";

/** One row of the per-profile Model/Thinking settings menu (TUI and dialog). */
export interface SettingsRow {
	action: SettingsAction;
	label: string;
	value: string;
	override: boolean;
}

export function compareModels(left: Model<Api>, right: Model<Api>): number {
	const provider = left.provider.localeCompare(right.provider);
	return provider !== 0 ? provider : left.id.localeCompare(right.id);
}

export interface SettingsRowsOptions {
	override: SubagentProfileOverride | undefined;
	models: readonly Model<Api>[];
	currentSessionModel: Model<Api> | undefined;
	currentThinking: ThinkingLevel;
}

export function buildSettingsRows(options: SettingsRowsOptions): SettingsRow[] {
	const effective = effectiveModel(options.currentSessionModel, options.models, options.override);
	return [
		{
			action: "model",
			label: "Model",
			value: options.override?.model
				? `override — ${options.override.model}${findModel(options.models, options.override.model) ? "" : " [unavailable]"}`
				: `inherit — ${modelId(options.currentSessionModel)}`,
			override: options.override?.model !== undefined,
		},
		{
			action: "thinking",
			label: "Thinking",
			value: options.override?.thinking
				? `override — ${options.override.thinking}`
				: `inherit — ${inheritedThinking(effective, options.currentThinking)}`,
			override: options.override?.thinking !== undefined,
		},
	];
}

export interface ModelChoicesOptions {
	/** Sorted catalog; see compareModels. */
	models: readonly Model<Api>[];
	currentSessionModel: Model<Api> | undefined;
	savedModelId: string | undefined;
}

/** Dialog picker choices: label → model id (undefined means inherit). */
export function buildModelChoices(options: ModelChoicesOptions): Map<string, string | undefined> {
	const choices = new Map<string, string | undefined>();
	choices.set(`inherit (${modelId(options.currentSessionModel)})${options.savedModelId ? "" : " ✓"}`, undefined);
	if (options.savedModelId && !findModel(options.models, options.savedModelId)) {
		choices.set(`${options.savedModelId} [unavailable] ✓`, options.savedModelId);
	}
	for (const model of options.models) {
		const id = modelId(model);
		choices.set(`${id}${options.savedModelId === id ? " ✓" : ""}`, id);
	}
	return choices;
}

export interface ThinkingChoicesOptions {
	currentSessionModel: Model<Api> | undefined;
	models: readonly Model<Api>[];
	override: SubagentProfileOverride | undefined;
	currentThinking: ThinkingLevel;
}

/** Dialog picker choices: label → level (undefined means inherit). */
export function buildThinkingChoices(options: ThinkingChoicesOptions): Map<string, ThinkingLevel | undefined> {
	const effective = effectiveModel(options.currentSessionModel, options.models, options.override);
	const levels = effective ? (getSupportedThinkingLevels(effective) as ThinkingLevel[]) : [...THINKING_LEVELS];
	const inherited = inheritedThinking(effective, options.currentThinking);
	const choices = new Map<string, ThinkingLevel | undefined>();
	choices.set(`inherit (${inherited})${options.override?.thinking ? "" : " ✓"}`, undefined);
	for (const level of levels) {
		choices.set(`${level}${options.override?.thinking === level ? " ✓" : ""}`, level);
	}
	return choices;
}
