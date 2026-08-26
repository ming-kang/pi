import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Container,
	type Focusable,
	isFocusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { AGENT_PROFILE_LABELS, AGENT_PROFILES } from "./agents.ts";
import { loadSubagentConfig, updateProfileOverride } from "./settings.ts";
import type { AgentProfile, SubagentConfigFile, SubagentProfileOverride } from "./types.ts";
import { showDialogAgentsCommand } from "./ui/agents-dialog.ts";
import { ChoiceMenuComponent } from "./ui/choice-menu.ts";
import { buildThinkingChoices, type SettingsAction } from "./ui/choices.ts";
import { ModelPickerComponent, refreshPickerModels } from "./ui/model-picker.ts";
import { ProfileSettingsMenuComponent } from "./ui/profile-settings-menu.ts";

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

export async function showAgentsCommand(ctx: ExtensionCommandContext, currentThinking: ThinkingLevel): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/agents requires an interactive UI.", "warning");
		return;
	}
	if (ctx.mode === "tui") await showTuiAgentsCommand(ctx, currentThinking);
	else await showDialogAgentsCommand(ctx, currentThinking);
}
