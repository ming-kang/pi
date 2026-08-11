import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { Container, type Focusable, type KeybindingsManager, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { THINKING_LEVELS } from "../constants.ts";
import { displayAgentDescription, displayAgentName } from "../display-name.ts";
import type { AgentDefinition, SubagentProfileOverride } from "../types.ts";
import { type ProfileModelChoice, ProfileModelListComponent } from "./model-list.ts";

export interface ProfileEditorResult {
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
}

export interface ProfileEditorOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	agent: AgentDefinition;
	override: SubagentProfileOverride | undefined;
	models: readonly Model<Api>[];
	scopedModels: readonly { model: Model<Api> }[];
	currentSessionModel: Model<Api> | undefined;
	currentThinking: ThinkingLevel;
	onDone: (result: ProfileEditorResult | undefined) => void;
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

/** Unified model and thinking editor for one Subagent profile. */
export class ProfileEditorComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly currentThinking: ThinkingLevel;
	private readonly onDone: (result: ProfileEditorResult | undefined) => void;
	private readonly thinkingContainer: Container;
	private readonly modelList: ProfileModelListComponent;
	private readonly refreshAbortController = new AbortController();
	private candidateModel: ProfileModelChoice | undefined;
	private candidateThinking: ThinkingLevel | undefined;
	private availableThinking: ThinkingLevel[] = [];
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.modelList.focused = value;
	}

	constructor(options: ProfileEditorOptions) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.currentThinking = options.currentThinking;
		this.onDone = options.onDone;
		this.candidateThinking = options.override?.thinking;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(displayAgentName(options.agent.name))), 1, 0));
		this.addChild(new Text(this.theme.fg("muted", displayAgentDescription(options.agent)), 1, 0));
		this.addChild(new Spacer(1));

		this.thinkingContainer = new Container();
		this.addChild(this.thinkingContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("text", this.theme.bold("Model")), 1, 0));

		this.modelList = new ProfileModelListComponent({
			theme: options.theme,
			keybindings: options.keybindings,
			models: options.models,
			scopedModels: options.scopedModels,
			currentSessionModel: options.currentSessionModel,
			savedModelId: options.override?.model,
			onSelectionChange: (choice) => this.handleModelSelection(choice),
		});
		this.addChild(this.modelList);
		this.addChild(new Spacer(1));

		const navigationKeys = [
			keyLabel("tui.select.up", { keybindings: options.keybindings }),
			keyLabel("tui.select.down", { keybindings: options.keybindings }),
		]
			.filter(Boolean)
			.join("/");
		const hints = [
			navigationKeys ? `${this.theme.fg("dim", navigationKeys)}${this.theme.fg("muted", " navigate")}` : "",
			options.scopedModels.length > 0 ? hint(this.theme, options.keybindings, "tui.input.tab", "scope") : "",
			hint(this.theme, options.keybindings, "app.thinking.cycle", "thinking"),
			hint(this.theme, options.keybindings, "tui.select.confirm", "apply"),
			hint(this.theme, options.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.addChild(new Text(hints.join(this.theme.fg("muted", " • ")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private handleModelSelection(choice: ProfileModelChoice | undefined): void {
		this.candidateModel = choice;
		const model = choice?.model;
		this.availableThinking = model ? (getSupportedThinkingLevels(model) as ThinkingLevel[]) : [...THINKING_LEVELS];
		if (this.candidateThinking !== undefined && model && !this.availableThinking.includes(this.candidateThinking)) {
			this.candidateThinking = clampThinkingLevel(model, this.candidateThinking) as ThinkingLevel;
		}
		this.updateThinkingView();
	}

	private inheritedThinking(): ThinkingLevel {
		return this.candidateModel?.model
			? (clampThinkingLevel(this.candidateModel.model, this.currentThinking) as ThinkingLevel)
			: this.currentThinking;
	}

	private updateThinkingView(): void {
		this.thinkingContainer.clear();
		const choices: Array<ThinkingLevel | undefined> = [undefined, ...this.availableThinking];
		const rendered = choices.map((choice) => {
			const label = choice === undefined ? `inherit (${this.inheritedThinking()})` : choice;
			const selected = choice === this.candidateThinking;
			return selected
				? `${this.theme.fg("accent", label)}${this.theme.fg("success", " ✓")}`
				: this.theme.fg("muted", label);
		});
		this.thinkingContainer.addChild(
			new Text(
				`${this.theme.fg("text", this.theme.bold("Thinking"))}  ${rendered.join(this.theme.fg("muted", " · "))}`,
				1,
				0,
			),
		);
	}

	private cycleThinking(): void {
		if (!this.candidateModel) return;
		const choices: Array<ThinkingLevel | undefined> = [undefined, ...this.availableThinking];
		const currentIndex = choices.indexOf(this.candidateThinking);
		this.candidateThinking = choices[(currentIndex + 1 + choices.length) % choices.length];
		this.updateThinkingView();
	}

	private confirm(): void {
		if (!this.candidateModel) return;
		this.dispose();
		this.onDone({
			model: this.candidateModel.modelId,
			thinking: this.candidateThinking,
		});
	}

	get refreshSignal(): AbortSignal {
		return this.refreshAbortController.signal;
	}

	cancelRefresh(): void {
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
		if (this.keybindings.matches(data, "app.thinking.cycle")) {
			this.cycleThinking();
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.onDone(undefined);
		} else {
			this.modelList.handleInput(data);
		}
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.refreshAbortController.abort();
	}
}
