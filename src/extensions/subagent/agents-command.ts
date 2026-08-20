import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	isFocusable,
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
import type { AgentProfile, SubagentConfigFile, SubagentProfileOverride } from "./types.ts";
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

interface MenuChoice<T> {
	label: string;
	value: T;
}

/** Small Pi-native list page used inside the single /agents custom UI lifecycle. */
class ChoiceMenuComponent<T> extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly choices: readonly MenuChoice<T>[];
	private readonly onDone: (choice: MenuChoice<T> | undefined) => void;
	private readonly title: string;
	private readonly cancelDescription: "back" | "close";
	private readonly titleText: Text;
	private readonly hintText: Text;
	private readonly listContainer: Container;
	private selectedIndex: number;
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
		title: string;
		choices: readonly MenuChoice<T>[];
		onDone: (choice: MenuChoice<T> | undefined) => void;
		initialIndex?: number;
		cancelDescription: "back" | "close";
	}) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.choices = options.choices;
		this.onDone = options.onDone;
		this.title = options.title;
		this.cancelDescription = options.cancelDescription;
		this.selectedIndex = Math.min(Math.max(options.initialIndex ?? 0, 0), Math.max(0, options.choices.length - 1));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
		this.updateList();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", this.cancelDescription),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
	}

	private updateList(): void {
		this.listContainer.clear();
		for (const [index, choice] of this.choices.entries()) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = this.theme.fg(selected ? "accent" : "text", choice.label);
			this.listContainer.addChild(new TruncatedText(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.choices.length === 0) return;
		this.selectedIndex = (this.selectedIndex + offset + this.choices.length) % this.choices.length;
		this.updateList();
	}

	override invalidate(): void {
		this.updateStaticText();
		this.updateList();
		super.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const choice = this.choices[this.selectedIndex];
			if (choice) this.onDone(choice);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		}
	}
}

/** Compact Model/Thinking settings menu for one profile; every confirm persists immediately. */
class ProfileSettingsMenuComponent extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly rows: readonly SettingsRow[];
	private readonly onDone: (action: SettingsAction | undefined) => void;
	private readonly title: string;
	private readonly status: string | undefined;
	private readonly titleText: Text;
	private readonly statusText: Text | undefined;
	private readonly hintText: Text;
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
		selectedAction?: SettingsAction;
		status?: string;
		onDone: (action: SettingsAction | undefined) => void;
	}) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onDone = options.onDone;
		this.title = AGENT_PROFILE_LABELS[options.profile.name];
		this.status = options.status;
		this.rows = buildSettingsRows({
			override: options.override,
			models: options.models,
			currentSessionModel: options.currentSessionModel,
			currentThinking: options.currentThinking,
		}) satisfies SettingsRow[];
		this.selectedIndex = Math.max(
			0,
			this.rows.findIndex((row) => row.action === options.selectedAction),
		);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		if (this.status) {
			this.statusText = new Text("", 1, 0);
			this.addChild(this.statusText);
			this.addChild(new Spacer(1));
		} else {
			this.statusText = undefined;
		}
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
		this.updateList();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		this.statusText?.setText(this.theme.fg("muted", this.status ?? ""));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
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

	override invalidate(): void {
		this.updateStaticText();
		this.updateList();
		super.invalidate();
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

/** Searchable model page for one profile; confirm saves immediately. */
class ModelPickerComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly title: string;
	private readonly hasScopedModels: boolean;
	private readonly titleText: Text;
	private readonly hintText: Text;
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
		this.title = `Model — ${AGENT_PROFILE_LABELS[options.profile.name]}`;
		this.hasScopedModels = options.scopedModels.length > 0;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
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
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			this.hasScopedModels ? hint(this.theme, this.keybindings, "tui.input.tab", "scope") : "",
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
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

	override invalidate(): void {
		this.updateStaticText();
		super.invalidate();
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

type AgentsMenuRoute =
	| { kind: "profiles" }
	| { kind: "settings"; profile: AgentProfile; selectedAction: SettingsAction }
	| { kind: "model"; profile: AgentProfile }
	| { kind: "thinking"; profile: AgentProfile };

/** One mounted /agents TUI whose child pages switch without restoring the editor between them. */
class AgentsMenuComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly ctx: ExtensionCommandContext;
	private readonly currentThinking: ThinkingLevel;
	private readonly onDone: () => void;
	private config: SubagentConfigFile;
	private activeScreen: (Component & { dispose?(): void }) | undefined;
	private route: AgentsMenuRoute = { kind: "profiles" };
	private selectedProfile: AgentProfile | undefined;
	private selectedSettingsAction: SettingsAction = "model";
	private saving = false;
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.activeScreen && isFocusable(this.activeScreen)) this.activeScreen.focused = value;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		ctx: ExtensionCommandContext;
		currentThinking: ThinkingLevel;
		config: SubagentConfigFile;
		onDone: () => void;
	}) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.ctx = options.ctx;
		this.currentThinking = options.currentThinking;
		this.config = options.config;
		this.onDone = options.onDone;
		this.showProfiles();
	}

	private disposeActiveScreen(): void {
		const screen = this.activeScreen;
		this.activeScreen = undefined;
		if (!screen) return;
		const disposable = screen as Component & { dispose?(): void };
		if (isFocusable(screen)) screen.focused = false;
		disposable.dispose?.();
	}

	private setActiveScreen(screen: Component & { dispose?(): void }): void {
		this.disposeActiveScreen();
		this.clear();
		this.activeScreen = screen;
		this.addChild(screen);
		if (isFocusable(screen)) screen.focused = this._focused;
		this.tui.requestRender();
	}

	private showProfiles(): void {
		this.route = { kind: "profiles" };
		const choices = AGENT_PROFILES.map((profile) => ({
			label: AGENT_PROFILE_LABELS[profile.name],
			value: profile,
		}));
		const initialIndex = choices.findIndex((choice) => choice.value.name === this.selectedProfile?.name);
		this.setActiveScreen(
			new ChoiceMenuComponent({
				theme: this.theme,
				keybindings: this.keybindings,
				title: "Agents",
				choices,
				initialIndex,
				cancelDescription: "close",
				onDone: (choice) => {
					if (!choice) {
						this.onDone();
						return;
					}
					this.selectedProfile = choice.value;
					this.selectedSettingsAction = "model";
					this.showSettings(choice.value);
				},
			}),
		);
	}

	private showSettings(profile: AgentProfile, selectedAction = this.selectedSettingsAction): void {
		this.selectedProfile = profile;
		this.selectedSettingsAction = selectedAction;
		this.route = { kind: "settings", profile, selectedAction };
		this.setActiveScreen(
			new ProfileSettingsMenuComponent({
				theme: this.theme,
				keybindings: this.keybindings,
				profile,
				override: this.config.profiles[profile.name],
				models: this.ctx.modelRegistry.getAvailable(),
				currentSessionModel: this.ctx.model,
				currentThinking: this.currentThinking,
				selectedAction,
				status: this.saving ? "Saving…" : undefined,
				onDone: (action) => {
					if (!action) {
						this.showProfiles();
						return;
					}
					this.selectedSettingsAction = action;
					if (action === "model") this.showModelPicker(profile);
					else this.showThinkingPicker(profile);
				},
			}),
		);
	}

	private showModelPicker(profile: AgentProfile): void {
		this.route = { kind: "model", profile };
		const override = this.config.profiles[profile.name];
		const picker = new ModelPickerComponent({
			tui: this.tui,
			theme: this.theme,
			keybindings: this.keybindings,
			profile,
			savedModelId: override?.model,
			models: this.ctx.modelRegistry.getAvailable(),
			scopedModels: this.ctx.scopedModels,
			currentSessionModel: this.ctx.model,
			onDone: (choice) => {
				if (!choice) {
					this.showSettings(profile, "model");
					return;
				}
				this.saveOverride(profile, { model: choice.modelId }, "model");
			},
		});
		picker.setRefreshStatus("Refreshing model catalogs…");
		this.setActiveScreen(picker);
		void refreshPickerModels(this.ctx, picker);
	}

	private showThinkingPicker(profile: AgentProfile): void {
		this.route = { kind: "thinking", profile };
		const override = this.config.profiles[profile.name];
		const choices = [
			...buildThinkingChoices({
				currentSessionModel: this.ctx.model,
				models: this.ctx.modelRegistry.getAvailable(),
				override,
				currentThinking: this.currentThinking,
			}).entries(),
		].map(([label, level]) => ({ label, value: level }));
		const initialIndex = choices.findIndex((choice) => choice.label.endsWith(" ✓"));
		this.setActiveScreen(
			new ChoiceMenuComponent({
				theme: this.theme,
				keybindings: this.keybindings,
				title: `Thinking — ${AGENT_PROFILE_LABELS[profile.name]}`,
				choices,
				initialIndex,
				cancelDescription: "back",
				onDone: (choice) => {
					if (!choice) {
						this.showSettings(profile, "thinking");
						return;
					}
					this.saveOverride(profile, { thinking: choice.value }, "thinking");
				},
			}),
		);
	}

	private saveOverride(
		profile: AgentProfile,
		patch: Partial<SubagentProfileOverride>,
		returnAction: SettingsAction,
	): void {
		if (this.saving) return;
		this.saving = true;
		this.showSettings(profile, returnAction);
		void persistOverride(this.ctx, profile, patch)
			.then(
				(config) => this.completeSave(profile, config),
				() => this.completeSave(profile, undefined),
			)
			.catch(() => {
				// A reload can stale the command context while the queued file write finishes.
			});
	}

	private completeSave(profile: AgentProfile, config: SubagentConfigFile | undefined): void {
		if (this.closed) return;
		this.saving = false;
		if (config) this.config = config;
		if (this.route.kind === "settings" && this.route.profile.name === profile.name) {
			this.showSettings(profile, this.route.selectedAction);
		}
	}

	handleInput(data: string): void {
		if (!this.saving) {
			this.activeScreen?.handleInput?.(data);
			return;
		}
		if (!this.keybindings.matches(data, "tui.select.cancel")) return;
		if (this.route.kind === "settings") this.showProfiles();
		else if (this.route.kind === "profiles") this.onDone();
	}

	dispose(): void {
		this.closed = true;
		this.disposeActiveScreen();
		this.clear();
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
		const config = await loadSubagentConfig(agentDir);
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

async function showTuiAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	const config = await loadSubagentConfig(getAgentDir());
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new AgentsMenuComponent({
				tui,
				theme,
				keybindings,
				ctx,
				currentThinking,
				config,
				onDone: () => done(),
			}),
	);
}

async function showDialogAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	while (true) {
		const profile = await selectProfile(ctx);
		if (!profile) return;
		await runDialogProfileSettings(ctx, profile, currentThinking);
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
