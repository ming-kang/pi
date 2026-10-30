import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { ModelSelectorComponent } from "../../modes/interactive/components/model-selector.ts";
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
		throw new Error("Invalid Agent thinking setting. Choose a thinking level with /agent.");
	return { model: inspection.model, thinking: inspection.thinking };
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

function formatInvalid(value: unknown): string {
	let text = "";
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	} catch {}
	const label = truncateHead(text, { maxLines: 1, maxBytes: 80 }).content;
	return label ? `${label} [invalid]` : "[invalid]";
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
		let inspection: InspectedAgentSettings;
		try {
			inspection = inspectAgentSettings(ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		let modelLabel: string;
		if (inspection.invalidModel !== undefined) {
			modelLabel = formatInvalid(inspection.invalidModel);
		} else if (inspection.model) {
			const modelAvailable = ctx.modelRuntime
				.getAvailableSnapshot()
				.some((model) => `${model.provider}/${model.id}` === inspection.model);
			modelLabel = `${inspection.model}${modelAvailable ? "" : " [unavailable]"}`;
		} else {
			modelLabel = `Follow current session${ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : ""}`;
		}
		let thinkingLabel: string;
		if (inspection.invalidThinking !== undefined) {
			thinkingLabel = formatInvalid(inspection.invalidThinking);
		} else if (inspection.thinking) {
			thinkingLabel = inspection.thinking;
		} else {
			thinkingLabel = `Follow current session (${ctx.thinkingLevel ?? DEFAULT_THINKING_LEVEL})`;
		}
		const modelAction = `Model · ${modelLabel}`;
		const thinkingAction = `Thinking · ${thinkingLabel}`;
		const followModelAction = "Reset model to follow current session";
		const followThinkingAction = "Reset thinking to follow current session";
		const hasModelOverride = inspection.model !== undefined || inspection.invalidModel !== undefined;
		const hasThinkingOverride = inspection.thinking !== undefined || inspection.invalidThinking !== undefined;
		const action = await ctx.ui.select("Agent settings", [
			modelAction,
			thinkingAction,
			...(hasModelOverride ? [followModelAction] : []),
			...(hasThinkingOverride ? [followThinkingAction] : []),
		]);
		if (!action) return;
		try {
			if (action === followModelAction) {
				await saveAgentSettings(ctx, { model: null });
				ctx.ui.notify("Agent model: Follow current session", "info");
			} else if (action === followThinkingAction) {
				await saveAgentSettings(ctx, { thinking: null });
				ctx.ui.notify("Agent thinking: Follow current session", "info");
			} else if (action === modelAction) {
				const selected = await selectAgentModel(ctx, inspection.model ?? "");
				if (selected === undefined || selected === inspection.model) continue;
				await saveAgentSettings(ctx, { model: selected });
				ctx.ui.notify(`Agent model: ${selected}`, "info");
			} else if (action === thinkingAction) {
				let supported: Set<ThinkingLevel> | undefined;
				if (inspection.model) {
					const slash = inspection.model.indexOf("/");
					const model = ctx.modelRuntime.getModel(
						inspection.model.slice(0, slash),
						inspection.model.slice(slash + 1),
					);
					if (model) supported = new Set(getSupportedThinkingLevels(model));
				}
				if (!supported && ctx.model) {
					supported = new Set(getSupportedThinkingLevels(ctx.model));
				}
				const selected = await ctx.ui.select("Agent thinking", [
					"Follow current session",
					...THINKING_LEVEL_OPTIONS.filter((level) => !supported || supported.has(level)),
				]);
				if (selected === undefined) continue;
				const thinking = selected === "Follow current session" ? null : (selected as ThinkingLevel);
				if ((thinking ?? undefined) === inspection.thinking && inspection.invalidThinking === undefined) continue;
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
