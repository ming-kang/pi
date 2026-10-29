import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { ModelSelectorComponent } from "../../modes/interactive/components/model-selector.ts";
import { AGENT_SETTINGS_NAMESPACE, type AgentSettings } from "./types.ts";

type SettingsContext = Pick<ExtensionContext, "getExtensionSettings" | "setExtensionSettings">;
type ModelContext = Pick<ExtensionContext, "model" | "modelRuntime" | "thinkingLevel">;

export function readAgentSettings(ctx: Pick<ExtensionContext, "getExtensionSettings">): AgentSettings {
	const value = ctx.getExtensionSettings(AGENT_SETTINGS_NAMESPACE);
	if (value.model !== undefined && (typeof value.model !== "string" || !value.model.includes("/")))
		throw new Error("Invalid Agent model setting. Choose a model with /agent.");
	if (
		value.thinking !== undefined &&
		(typeof value.thinking !== "string" || !THINKING_LEVEL_OPTIONS.includes(value.thinking as ThinkingLevel))
	)
		throw new Error("Invalid Agent thinking setting. Choose a thinking level with /agent.");
	return { model: value.model as string | undefined, thinking: value.thinking as ThinkingLevel | undefined };
}

export function resolveAgentConfiguration(ctx: ModelContext & Pick<ExtensionContext, "getExtensionSettings">): {
	model: Model<any>;
	thinking: ThinkingLevel;
	settings: AgentSettings;
} {
	const settings = readAgentSettings(ctx);
	let model: Model<any> | undefined;
	if (settings.model) {
		const slash = settings.model.indexOf("/");
		model = ctx.modelRuntime.getModel(settings.model.slice(0, slash), settings.model.slice(slash + 1));
		if (!model) throw new Error(`Agent model is unavailable: ${settings.model}`);
	} else model = ctx.model;
	if (!model) throw new Error("Agent has no model to follow. Choose one with /agent.");
	const thinking = clampThinkingLevel(
		model,
		settings.thinking ?? ctx.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
	) as ThinkingLevel;
	return { model, thinking, settings };
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
	const saved = ctx.modelRuntime.getAvailableSnapshot().find((model) => `${model.provider}/${model.id}` === current);
	const selected = await ctx.ui.custom<Model<any> | undefined>(
		(tui, _theme, _keys, done) =>
			new ModelSelectorComponent(
				tui,
				saved ?? ctx.model,
				ctx.modelRuntime,
				ctx.scopedModels,
				(model) => done(model),
				() => done(undefined),
			),
	);
	return selected ? `${selected.provider}/${selected.id}` : undefined;
}

/** Two small native selectors; every confirmed choice affects future Agents only. */
export async function openAgentSettings(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		try {
			const settings = readAgentSettings(ctx);
			ctx.ui.notify(
				`Agent model: ${settings.model ?? "Follow current session"} · Thinking: ${settings.thinking ?? "Follow current session"}`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	while (true) {
		let settings: AgentSettings;
		try {
			settings = readAgentSettings(ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		const modelAvailable = settings.model
			? ctx.modelRuntime.getAvailableSnapshot().some((model) => `${model.provider}/${model.id}` === settings.model)
			: true;
		const modelLabel = settings.model
			? `${settings.model}${modelAvailable ? "" : " [unavailable]"}`
			: `Follow current session${ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : ""}`;
		const thinkingLabel =
			settings.thinking ?? `Follow current session (${ctx.thinkingLevel ?? DEFAULT_THINKING_LEVEL})`;
		const modelAction = `Model · ${modelLabel}`;
		const thinkingAction = `Thinking · ${thinkingLabel}`;
		const followAction = "Reset model to follow current session";
		const action = await ctx.ui.select("Agent settings", [
			modelAction,
			thinkingAction,
			...(settings.model ? [followAction] : []),
		]);
		if (!action) return;
		try {
			if (action === followAction) {
				await saveAgentSettings(ctx, { model: null });
				ctx.ui.notify("Agent model: Follow current session", "info");
			} else if (action === modelAction) {
				const selected = await selectAgentModel(ctx, settings.model ?? "");
				if (selected === undefined || selected === settings.model) continue;
				await saveAgentSettings(ctx, { model: selected });
				ctx.ui.notify(`Agent model: ${selected}`, "info");
			} else if (action === thinkingAction) {
				const { model } = resolveAgentConfiguration(ctx);
				const supported = new Set(getSupportedThinkingLevels(model));
				const selected = await ctx.ui.select("Agent thinking", [
					"Follow current session",
					...THINKING_LEVEL_OPTIONS.filter((level) => supported.has(level)),
				]);
				if (selected === undefined) continue;
				const thinking = selected === "Follow current session" ? null : (selected as ThinkingLevel);
				if ((thinking ?? undefined) === settings.thinking) continue;
				await saveAgentSettings(ctx, { thinking });
				ctx.ui.notify(`Agent thinking: ${thinking ?? "Follow current session"}`, "info");
			}
		} catch (error) {
			ctx.ui.notify(
				`Could not save Agent settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}
}
