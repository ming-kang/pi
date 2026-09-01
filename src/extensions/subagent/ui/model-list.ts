import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { getModelSelectorSearchText } from "../../../modes/interactive/model-search.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { modelId, parseModelSpec } from "../model-selection.ts";
import { compareModels } from "./choices.ts";

const MAX_VISIBLE_MODELS = 10;

type ModelScope = "all" | "scoped";
type StatusTone = "muted" | "success" | "error";

export interface ProfileModelChoice {
	/** Undefined represents inheriting the current session model. */
	modelId: string | undefined;
	/** Effective model for capability checks; unavailable saved overrides have none. */
	model: Model<Api> | undefined;
	unavailable: boolean;
}

export interface ProfileModelListOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	models: readonly Model<Api>[];
	scopedModels: readonly { model: Model<Api> }[];
	currentSessionModel: Model<Api> | undefined;
	savedModelId: string | undefined;
	/** Reports the confirmed choice; undefined means the picker was dismissed. */
	onDone: (choice: ProfileModelChoice | undefined) => void;
}

interface ModelChoiceItem extends ProfileModelChoice {
	key: string;
	provider: string;
	id: string;
	name: string | undefined;
}

function modelSearchText(item: ModelChoiceItem): string {
	if (item.modelId === undefined) {
		return `inherit ${item.model ? getModelSelectorSearchText(item.model) : ""}`;
	}
	return getModelSelectorSearchText(item);
}

/** Searchable /model-style model picker used by /agents; confirm reports the selected choice. */
export class ProfileModelListComponent extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly currentSessionModel: Model<Api> | undefined;
	private readonly savedModelId: string | undefined;
	private readonly scopedModelKeys: Set<string>;
	private readonly onDone: (choice: ProfileModelChoice | undefined) => void;
	private readonly searchInput: Input;
	private readonly scopeContainer: Container;
	private readonly listContainer: Container;
	private models: Model<Api>[];
	private allChoices: ModelChoiceItem[] = [];
	private scopedChoices: ModelChoiceItem[] = [];
	private activeChoices: ModelChoiceItem[] = [];
	private filteredChoices: ModelChoiceItem[] = [];
	private selectedIndex = 0;
	private scope: ModelScope;
	private statusMessage: string | undefined;
	private statusTone: StatusTone = "muted";
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(options: ProfileModelListOptions) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.models = [...options.models];
		this.currentSessionModel = options.currentSessionModel;
		this.savedModelId = options.savedModelId;
		this.scopedModelKeys = new Set(options.scopedModels.map(({ model }) => modelId(model)));
		this.scope = this.scopedModelKeys.size > 0 ? "scoped" : "all";
		this.onDone = options.onDone;

		this.scopeContainer = new Container();
		this.addChild(this.scopeContainer);
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.rebuildChoices(this.savedModelId ?? "");
	}

	private makeInheritChoice(): ModelChoiceItem {
		return {
			key: "",
			modelId: undefined,
			model: this.currentSessionModel,
			unavailable: false,
			provider: this.currentSessionModel?.provider ?? "",
			id: "inherit",
			name: this.currentSessionModel?.name,
		};
	}

	private makeModelChoice(model: Model<Api>): ModelChoiceItem {
		return {
			key: modelId(model),
			modelId: modelId(model),
			model,
			unavailable: false,
			provider: model.provider,
			id: model.id,
			name: model.name,
		};
	}

	private makeUnavailableChoice(modelId: string): ModelChoiceItem {
		const parsed = parseModelSpec(modelId);
		return {
			key: modelId,
			modelId,
			model: undefined,
			unavailable: true,
			provider: parsed.provider,
			id: parsed.id,
			name: undefined,
		};
	}

	private buildChoices(models: readonly Model<Api>[]): ModelChoiceItem[] {
		const sorted = [...models].sort(compareModels);
		const availableById = new Map(this.models.map((model) => [modelId(model), model]));
		const choices: ModelChoiceItem[] = [this.makeInheritChoice()];
		if (this.savedModelId) {
			const saved = availableById.get(this.savedModelId);
			choices.push(saved ? this.makeModelChoice(saved) : this.makeUnavailableChoice(this.savedModelId));
		}
		for (const model of sorted) {
			if (modelId(model) !== this.savedModelId) choices.push(this.makeModelChoice(model));
		}
		return choices;
	}

	private rebuildChoices(preferredKey?: string): void {
		const currentKey = preferredKey ?? this.filteredChoices[this.selectedIndex]?.key ?? this.savedModelId ?? "";
		this.allChoices = this.buildChoices(this.models);
		const scopedModels = this.models.filter((model) => this.scopedModelKeys.has(modelId(model)));
		this.scopedChoices = this.buildChoices(scopedModels);
		this.activeChoices = this.scope === "scoped" ? this.scopedChoices : this.allChoices;
		this.applyFilter(this.searchInput.getValue(), currentKey, false);
		this.updateScopeView();
	}

	private applyFilter(query: string, preferredKey?: string, resetSelection = true): void {
		this.filteredChoices = query ? fuzzyFilter(this.activeChoices, query, modelSearchText) : this.activeChoices;
		if (preferredKey !== undefined) {
			const preferredIndex = this.filteredChoices.findIndex((choice) => choice.key === preferredKey);
			this.selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
		} else if (query && resetSelection) {
			this.selectedIndex = 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredChoices.length - 1));
		}
		this.updateList();
	}

	private updateScopeView(): void {
		this.scopeContainer.clear();
		if (this.scopedModelKeys.size === 0) {
			this.scopeContainer.addChild(
				new Text(
					this.theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."),
					0,
					0,
				),
			);
			this.scopeContainer.addChild(new Spacer(1));
			return;
		}
		const all = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
		const scoped = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
		this.scopeContainer.addChild(
			new Text(`${this.theme.fg("muted", "Scope: ")}${all}${this.theme.fg("muted", " | ")}${scoped}`, 0, 0),
		);
		this.scopeContainer.addChild(new Spacer(1));
	}

	private choiceLabel(choice: ModelChoiceItem): string {
		if (choice.modelId === undefined) {
			const inherited = choice.model ? modelId(choice.model) : "none";
			return `inherit ${this.theme.fg("muted", `(${inherited})`)}`;
		}
		if (choice.unavailable) {
			const badge = choice.provider ? `${choice.provider} · unavailable` : "unavailable";
			return `${choice.id} ${this.theme.fg("warning", `[${badge}]`)}`;
		}
		return `${choice.id} ${this.theme.fg("muted", `[${choice.provider}]`)}`;
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
				this.filteredChoices.length - MAX_VISIBLE_MODELS,
			),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_MODELS, this.filteredChoices.length);
		for (let index = startIndex; index < endIndex; index++) {
			const choice = this.filteredChoices[index];
			if (!choice) continue;
			const selected = index === this.selectedIndex;
			const saved = choice.modelId === this.savedModelId;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = this.choiceLabel(choice);
			const styledLabel = selected ? this.theme.fg("accent", label) : label;
			const checkmark = saved ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new TruncatedText(`${prefix}${styledLabel}${checkmark}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredChoices.length) {
			this.listContainer.addChild(
				new TruncatedText(
					this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredChoices.length})`),
					0,
					0,
				),
			);
		}
		if (this.filteredChoices.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredChoices[this.selectedIndex];
			if (selected?.model?.name) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
			}
		}
		if (this.statusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg(this.statusTone, `  ${this.statusMessage}`), 0, 0));
		}
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.filteredChoices.length === 0) return;
		this.selectedIndex = (this.selectedIndex + offset + this.filteredChoices.length) % this.filteredChoices.length;
		this.updateList();
	}

	private toggleScope(): void {
		if (this.scopedModelKeys.size === 0) return;
		const currentKey = this.filteredChoices[this.selectedIndex]?.key;
		this.scope = this.scope === "all" ? "scoped" : "all";
		this.activeChoices = this.scope === "scoped" ? this.scopedChoices : this.allChoices;
		this.applyFilter(this.searchInput.getValue(), currentKey, false);
		this.updateScopeView();
	}

	getSelectedChoice(): ProfileModelChoice | undefined {
		const selected = this.filteredChoices[this.selectedIndex];
		if (!selected) return undefined;
		return { modelId: selected.modelId, model: selected.model, unavailable: selected.unavailable };
	}

	updateModels(models: readonly Model<Api>[]): void {
		const selectedKey = this.filteredChoices[this.selectedIndex]?.key;
		this.models = [...models];
		this.rebuildChoices(selectedKey);
	}

	setStatus(message: string | undefined, tone: StatusTone = "muted"): void {
		this.statusMessage = message;
		this.statusTone = tone;
		this.updateList();
	}

	override invalidate(): void {
		this.updateScopeView();
		this.updateList();
		super.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.toggleScope();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.getSelectedChoice();
			if (selected) this.onDone(selected);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}
}
