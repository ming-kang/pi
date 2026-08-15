import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { AGENT_PROFILE_LABELS, AGENT_PROFILES } from "./agents.ts";
import { loadSubagentConfig, updateProfileOverride } from "./settings.ts";
import { truncate } from "./text.ts";
import type { AgentProfile, SubagentProfileOverride } from "./types.ts";
import {
	buildModelChoices,
	buildSettingsRows,
	buildThinkingChoices,
	compareModels,
	type SettingsAction,
	type SettingsRow,
} from "./ui/choices.ts";
import { type ProfileModelChoice, ProfileModelListComponent } from "./ui/model-list.ts";

const MODEL_REFRESH_TIMEOUT_MS = 15_000;
const MAX_REFRESH_ERROR_LENGTH = 240;

function refreshFailureMessage(providerIds: readonly string[]): string {
	if (providerIds.length === 1) return `Could not refresh ${providerIds[0]}; showing cached models.`;
	const visible = providerIds.slice(0, 3);
	const omitted = providerIds.length - visible.length;
	const suffix = omitted > 0 ? `, +${omitted} more` : "";
	return `Could not refresh ${providerIds.length} model catalogs (${visible.join(", ")}${suffix}); showing cached models.`;
}

function hint(
	theme: Theme,
	keybindings: KeybindingsManager,
	binding: Parameters<KeybindingsManager["getKeys"]>[0],
	description: string,
): string {
	const key = keyLabel(binding, { keybindings });
	return key ? `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}` : "";
}

function navigationHint(theme: Theme, keybindings: KeybindingsManager): string {
	const keys = [keyLabel("tui.select.up", { keybindings }), keyLabel("tui.select.down", { keybindings })]
		.filter(Boolean)
		.join("/");
	return keys ? `${theme.fg("dim", keys)}${theme.fg("muted", " navigate")}` : "";
}

/** Compact Model/Thinking settings menu for one profile; every confirm persists immediately. */
class ProfileSettingsMenuComponent extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly rows: readonly SettingsRow[];
	private readonly onDone: (action: SettingsAction | undefined) => void;
	private readonly listContainer: Container;
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(options: {
		theme: Theme;
		keybindings: KeybindingsManager;
		profile: AgentProfile;
		override: SubagentProfileOverride | undefined;
		models: readonly Model<Api>[];
		currentSessionModel: Model<Api> | undefined;
		currentThinking: ThinkingLevel;
		onDone: (action: SettingsAction | undefined) => void;
	}) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onDone = options.onDone;
		this.rows = buildSettingsRows({
			override: options.override,
			models: options.models,
			currentSessionModel: options.currentSessionModel,
			currentThinking: options.currentThinking,
		}) satisfies SettingsRow[];

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(this.theme.fg("accent", this.theme.bold(AGENT_PROFILE_LABELS[options.profile.name])), 1, 0),
		);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		const hints = [
			navigationHint(this.theme, options.keybindings),
			hint(this.theme, options.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, options.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.addChild(new Text(hints.join(this.theme.fg("muted", " • ")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = selected ? this.theme.fg("accent", row.label) : this.theme.fg("text", row.label);
			const value = this.theme.fg("muted", `— ${row.value}`);
			const checkmark = row.override ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new TruncatedText(`${prefix}${label} ${value}${checkmark}`, 1, 0));
		}
	}

	private moveSelection(offset: -1 | 1): void {
		this.selectedIndex = (this.selectedIndex + offset + this.rows.length) % this.rows.length;
		this.updateList();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.onDone(this.rows[this.selectedIndex]?.action);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		}
	}
}

/** Standalone searchable model picker for one profile; confirm saves immediately. */
class ModelPickerComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly modelList: ProfileModelListComponent;
	private readonly refreshAbortController = new AbortController();
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.modelList.focused = value;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		profile: AgentProfile;
		savedModelId: string | undefined;
		models: readonly Model<Api>[];
		scopedModels: readonly { model: Model<Api> }[];
		currentSessionModel: Model<Api> | undefined;
		onDone: (choice: ProfileModelChoice | undefined) => void;
	}) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				this.theme.fg("accent", this.theme.bold(`Model — ${AGENT_PROFILE_LABELS[options.profile.name]}`)),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.modelList = new ProfileModelListComponent({
			theme: options.theme,
			keybindings: options.keybindings,
			models: options.models,
			scopedModels: options.scopedModels,
			currentSessionModel: options.currentSessionModel,
			savedModelId: options.savedModelId,
			onDone: options.onDone,
		});
		this.addChild(this.modelList);
		this.addChild(new Spacer(1));
		const hints = [
			navigationHint(this.theme, options.keybindings),
			options.scopedModels.length > 0 ? hint(this.theme, options.keybindings, "tui.input.tab", "scope") : "",
			hint(this.theme, options.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, options.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.addChild(new Text(hints.join(this.theme.fg("muted", " • ")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	get refreshSignal(): AbortSignal {
		return this.refreshAbortController.signal;
	}

	cancelRefresh(): void {
		this.refreshAbortController.abort();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	dispose(): void {
		this.closed = true;
		this.refreshAbortController.abort();
	}

	updateModels(models: readonly Model<Api>[]): void {
		if (this.closed) return;
		this.modelList.updateModels(models);
		this.tui.requestRender();
	}

	setRefreshStatus(message: string | undefined, tone: "muted" | "success" | "error" = "muted"): void {
		if (this.closed) return;
		this.modelList.setStatus(message, tone);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.modelList.handleInput(data);
	}
}

/** Persist a single override atomically; the UI only reflects the value on success. */
async function persistOverride(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	patch: Partial<SubagentProfileOverride>,
	current: string | ThinkingLevel | undefined,
): Promise<void> {
	const next = "model" in patch ? patch.model : patch.thinking;
	if (next === current) return;
	try {
		await updateProfileOverride(profile.name, patch, getAgentDir());
	} catch (error) {
		ctx.ui.notify(
			`Could not save ${AGENT_PROFILE_LABELS[profile.name]} settings: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function refreshPickerModels(ctx: ExtensionCommandContext, picker: ModelPickerComponent): Promise<void> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		picker.cancelRefresh();
	}, MODEL_REFRESH_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const result = await ctx.modelRegistry.refresh({ signal: picker.refreshSignal });
		if (picker.isClosed || (picker.refreshSignal.aborted && !timedOut)) return;
		picker.updateModels(ctx.modelRegistry.getAvailable());
		if (result.aborted && timedOut) {
			picker.setRefreshStatus("Model refresh timed out; showing cached models.", "error");
			return;
		}
		const providerIds = [...result.errors.keys()];
		if (providerIds.length > 0) {
			picker.setRefreshStatus(refreshFailureMessage(providerIds), "error");
			return;
		}
		const registryError = ctx.modelRegistry.getError();
		if (registryError) {
			picker.setRefreshStatus(truncate(registryError, MAX_REFRESH_ERROR_LENGTH), "error");
			return;
		}
		picker.setRefreshStatus(undefined);
	} catch (error) {
		if (picker.isClosed || (picker.refreshSignal.aborted && !timedOut)) return;
		const message = timedOut
			? "Model refresh timed out; showing cached models."
			: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
		picker.setRefreshStatus(truncate(message, MAX_REFRESH_ERROR_LENGTH), "error");
	} finally {
		clearTimeout(timeout);
	}
}

async function selectProfile(ctx: ExtensionCommandContext): Promise<AgentProfile | undefined> {
	const labels = AGENT_PROFILES.map((profile) => AGENT_PROFILE_LABELS[profile.name]);
	const label = await ctx.ui.select("Agents", labels);
	return label === undefined
		? undefined
		: AGENT_PROFILES.find((profile) => AGENT_PROFILE_LABELS[profile.name] === label);
}

async function showTuiSettingsMenu(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	override: SubagentProfileOverride | undefined,
	currentThinking: ThinkingLevel,
): Promise<SettingsAction | undefined> {
	return ctx.ui.custom<SettingsAction | undefined>(
		(_tui, theme, keybindings, done) =>
			new ProfileSettingsMenuComponent({
				theme,
				keybindings,
				profile,
				override,
				models: ctx.modelRegistry.getAvailable(),
				currentSessionModel: ctx.model,
				currentThinking,
				onDone: done,
			}),
	);
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

async function showTuiModelPicker(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	override: SubagentProfileOverride | undefined,
): Promise<{ modelId: string | undefined } | undefined> {
	const chosen = await ctx.ui.custom<ProfileModelChoice | undefined>((tui, theme, keybindings, done) => {
		const picker = new ModelPickerComponent({
			tui,
			theme,
			keybindings,
			profile,
			savedModelId: override?.model,
			models: ctx.modelRegistry.getAvailable(),
			scopedModels: ctx.scopedModels,
			currentSessionModel: ctx.model,
			onDone: done,
		});
		picker.setRefreshStatus("Refreshing model catalogs…");
		void refreshPickerModels(ctx, picker);
		return picker;
	});
	return chosen === undefined ? undefined : { modelId: chosen.modelId };
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

async function showThinkingPicker(
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

async function runProfileSettings(
	ctx: ExtensionCommandContext,
	profile: AgentProfile,
	currentThinking: ThinkingLevel,
): Promise<void> {
	const agentDir = getAgentDir();
	const isTui = ctx.mode === "tui";
	while (true) {
		const config = await loadSubagentConfig(agentDir);
		const override = config.profiles[profile.name];
		const action = isTui
			? await showTuiSettingsMenu(ctx, profile, override, currentThinking)
			: await showDialogSettingsMenu(ctx, profile, override, currentThinking);
		if (!action) return;
		if (action === "model") {
			const chosen = isTui
				? await showTuiModelPicker(ctx, profile, override)
				: await showDialogModelPicker(ctx, profile, override);
			if (!chosen) continue;
			await persistOverride(ctx, profile, { model: chosen.modelId }, override?.model);
		} else {
			const chosen = await showThinkingPicker(ctx, profile, override, currentThinking);
			if (!chosen) continue;
			await persistOverride(ctx, profile, { thinking: chosen.level }, override?.thinking);
		}
	}
}

export async function showAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents requires an interactive UI.", "warning");
		return;
	}
	while (true) {
		const profile = await selectProfile(ctx);
		if (!profile) return;
		await runProfileSettings(ctx, profile, currentThinking);
	}
}
