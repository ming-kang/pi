import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { ModelSelectorComponent } from "../../modes/interactive/components/model-selector.ts";
import { ThinkingSelectorComponent } from "../../modes/interactive/components/thinking-selector.ts";
import {
	type AgentSettingsAction,
	type AgentSettingsField,
	AgentSettingsPanel,
	type AgentSettingsRow,
} from "./settings-panel.ts";
import { AGENT_SETTINGS_NAMESPACE, type AgentSettings } from "./types.ts";

type SettingsContext = Pick<ExtensionContext, "getExtensionSettings" | "setExtensionSettings">;
type ModelContext = Pick<ExtensionContext, "model" | "modelRuntime" | "thinkingLevel">;

interface InspectedAgentSettings extends AgentSettings {
	invalidModel?: unknown;
	invalidThinking?: unknown;
}

function inspectAgentSettings(ctx: Pick<ExtensionContext, "getExtensionSettings">): InspectedAgentSettings {
	const raw = ctx.getExtensionSettings(AGENT_SETTINGS_NAMESPACE);
	let model: string | undefined;
	let invalidModel: unknown;
	if (raw.model !== undefined) {
		if (typeof raw.model === "string" && raw.model.includes("/")) {
			model = raw.model;
		} else {
			invalidModel = raw.model;
		}
	}
	let thinking: ThinkingLevel | undefined;
	let invalidThinking: unknown;
	if (raw.thinking !== undefined) {
		if (typeof raw.thinking === "string" && THINKING_LEVEL_OPTIONS.includes(raw.thinking as ThinkingLevel)) {
			thinking = raw.thinking as ThinkingLevel;
		} else {
			invalidThinking = raw.thinking;
		}
	}
	return { model, thinking, invalidModel, invalidThinking };
}

export function readAgentSettings(ctx: Pick<ExtensionContext, "getExtensionSettings">): AgentSettings {
	const inspection = inspectAgentSettings(ctx);
	if (inspection.invalidModel !== undefined)
		throw new Error("Invalid Agent model setting. Choose a model with /agent.");
	if (inspection.invalidThinking !== undefined)
		throw new Error("Invalid Agent effort setting. Choose an effort level with /agent.");
	return { model: inspection.model, thinking: inspection.thinking };
}

interface AgentModelResolution {
	model: Model<any>;
	/** Listed by `/model` right now. The availability snapshot can lag auth changes, so this is display-only. */
	available: boolean;
}

function resolveAgentModel(
	ctx: Pick<ModelContext, "model" | "modelRuntime">,
	reference?: string,
): AgentModelResolution | undefined {
	if (!reference) return ctx.model ? { model: ctx.model, available: true } : undefined;
	const slash = reference.indexOf("/");
	if (slash <= 0) return undefined;
	const model = ctx.modelRuntime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
	if (!model) return undefined;
	const available = ctx.modelRuntime
		.getAvailableSnapshot()
		.some((item) => item.provider === model.provider && item.id === model.id);
	return { model, available };
}

function requestedEffort(ctx: Pick<ModelContext, "thinkingLevel">, settings: AgentSettings): ThinkingLevel {
	return settings.thinking ?? ctx.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

/** Clamp a requested level to what the model supports. */
function supportedEffort(model: Model<any>, requested: ThinkingLevel): ThinkingLevel {
	return clampThinkingLevel(model, requested) as ThinkingLevel;
}

export function resolveAgentConfiguration(ctx: ModelContext & Pick<ExtensionContext, "getExtensionSettings">): {
	model: Model<any>;
	thinking: ThinkingLevel;
	settings: AgentSettings;
} {
	const settings = readAgentSettings(ctx);
	const resolution = resolveAgentModel(ctx, settings.model);
	if (!resolution) {
		if (settings.model) throw new Error(`Agent model is unavailable: ${settings.model}`);
		throw new Error("Agent has no model to follow. Choose one with /agent.");
	}
	return {
		model: resolution.model,
		thinking: supportedEffort(resolution.model, requestedEffort(ctx, settings)),
		settings,
	};
}

async function saveAgentSettings(
	ctx: SettingsContext,
	patch: { model?: string | null; thinking?: ThinkingLevel | null },
): Promise<void> {
	const next = { ...ctx.getExtensionSettings(AGENT_SETTINGS_NAMESPACE) };
	if (patch.model === null || patch.model === "") delete next.model;
	else if (patch.model !== undefined) next.model = patch.model;
	if (patch.thinking === null) delete next.thinking;
	else if (patch.thinking !== undefined) next.thinking = patch.thinking;
	await ctx.setExtensionSettings(AGENT_SETTINGS_NAMESPACE, next);
}

async function selectAgentModel(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
	// Preselect the saved reference even when it is unavailable, so the picker can repair it.
	const saved = resolveAgentModel(ctx, current)?.model;
	const selected = await ctx.ui.custom<Model<any> | undefined>(
		(tui, _theme, _keys, done) =>
			new ModelSelectorComponent(tui, saved ?? ctx.model, ctx.modelRuntime, ctx.scopedModels, done, () =>
				done(undefined),
			),
	);
	return selected ? `${selected.provider}/${selected.id}` : undefined;
}

async function selectAgentThinking(
	ctx: ExtensionCommandContext,
	settings: AgentSettings,
	model: Model<any> | undefined,
): Promise<ThinkingLevel | undefined> {
	const requested = requestedEffort(ctx, settings);
	const current = model ? supportedEffort(model, requested) : requested;
	const available = model ? getSupportedThinkingLevels(model) : [...THINKING_LEVEL_OPTIONS];
	return ctx.ui.custom<ThinkingLevel | undefined>(
		(_tui, _theme, _keys, done) => new ThinkingSelectorComponent(current, available, done, () => done(undefined)),
	);
}

function formatInvalidValue(value: unknown): string {
	let text = "";
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	} catch {}
	return truncateHead(text, { maxLines: 1, maxBytes: 80 }).content;
}

function invalidField(raw: unknown): AgentSettingsField {
	return { value: formatInvalidValue(raw), status: "[invalid]", tone: "error" };
}

function describeModel(
	inspection: InspectedAgentSettings,
	resolution: AgentModelResolution | undefined,
): AgentSettingsField {
	if (inspection.invalidModel !== undefined) return invalidField(inspection.invalidModel);
	if (!resolution) return { value: inspection.model ?? "", status: "[unavailable]", tone: "warning" };
	return {
		value: `${resolution.model.provider}/${resolution.model.id}`,
		following: inspection.model === undefined,
		...(resolution.available ? {} : { status: "[unavailable]", tone: "warning" as const }),
	};
}

function describeEffort(
	ctx: ModelContext,
	inspection: InspectedAgentSettings,
	model: Model<any> | undefined,
): AgentSettingsField {
	if (inspection.invalidThinking !== undefined) return invalidField(inspection.invalidThinking);
	const requested = requestedEffort(ctx, inspection);
	const following = inspection.thinking === undefined;
	if (!model) return { value: requested, following, status: "[unresolved]", tone: "warning" };
	const effective = supportedEffort(model, requested);
	if (effective === requested) return { value: requested, following };
	return { value: `${requested} → ${effective}`, following, tone: "warning" };
}

function hasOverrides(inspection: InspectedAgentSettings): boolean {
	return (
		inspection.model !== undefined ||
		inspection.thinking !== undefined ||
		inspection.invalidModel !== undefined ||
		inspection.invalidThinking !== undefined
	);
}

function settingsRows(
	ctx: ModelContext,
	inspection: InspectedAgentSettings,
	resolution: AgentModelResolution | undefined,
): AgentSettingsRow[] {
	return [
		{ action: "model", label: "Model", field: describeModel(inspection, resolution) },
		{ action: "thinking", label: "Effort", field: describeEffort(ctx, inspection, resolution?.model) },
		{ action: "reset", label: "Reset to follow current session" },
	];
}

/** The native pickers save only Agent overrides; reset clears both in one write. */
export async function openAgentSettings(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		try {
			const settings = readAgentSettings(ctx);
			ctx.ui.notify(
				`Agent model: ${settings.model ?? "Follow current session"} · Effort: ${settings.thinking ?? "Follow current session"}`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	let selectedAction: AgentSettingsAction = "model";
	while (true) {
		let inspection: InspectedAgentSettings;
		try {
			inspection = inspectAgentSettings(ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		const resolution = inspection.invalidModel !== undefined ? undefined : resolveAgentModel(ctx, inspection.model);
		const action = await ctx.ui.custom<AgentSettingsAction | undefined>(
			(tui, theme, keys, done) =>
				new AgentSettingsPanel(
					tui,
					theme,
					keys,
					settingsRows(ctx, inspection, resolution),
					selectedAction,
					done,
					() => done(undefined),
				),
		);
		if (!action) return;
		selectedAction = action;
		try {
			if (action === "reset") {
				if (!hasOverrides(inspection)) continue;
				await saveAgentSettings(ctx, { model: null, thinking: null });
				ctx.ui.notify("Agent settings: Follow current session", "info");
			} else if (action === "model") {
				const selected = await selectAgentModel(ctx, inspection.model ?? "");
				if (selected === undefined || selected === inspection.model) continue;
				await saveAgentSettings(ctx, { model: selected });
				ctx.ui.notify(`Agent model: ${selected}`, "info");
			} else if (action === "thinking") {
				const selected = await selectAgentThinking(ctx, inspection, resolution?.model);
				if (
					selected === undefined ||
					(selected === inspection.thinking && inspection.invalidThinking === undefined)
				)
					continue;
				await saveAgentSettings(ctx, { thinking: selected });
				ctx.ui.notify(`Agent effort: ${selected}`, "info");
			}
		} catch (error) {
			ctx.ui.notify(
				`Could not save Agent settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}
}
