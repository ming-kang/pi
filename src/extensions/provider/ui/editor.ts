/**
 * Two-pane provider editor.
 *
 * Left column groups connection, models, and management actions. The right
 * column hosts the selected item's field pane and sub-pane stack. Both columns
 * scroll inside a fixed-height frame; below the wide-layout threshold, only
 * the focused column is shown. Typing on a value row overwrites, Enter tweaks
 * or enters, ←/→ switch panes, and Esc cancels/pops/backs out.
 */

import "../keybindings.ts";
import { type Component, type Focusable, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { builtinModelFields, builtinModelIds, isBuiltinProviderId } from "../catalog.ts";
import { effectiveModelSettings, hasProviderSettings } from "../configuration.ts";
import { fetchProviderModels, importProviderModels } from "../connection.ts";
import { type DraftModelHandle, ProviderEdits } from "../editing.ts";
import type { RefreshCoordinator } from "../refresh.ts";
import type { ModelsJsonStore } from "../store.ts";
import { BuiltinModelsPane } from "./builtin-models.ts";
import type { CredentialRuntime } from "./credential.ts";
import { ConfirmPane, InfoPane } from "./dialogs.ts";
import { FetchModelsPane } from "./fetch-models.ts";
import { ModelFieldsPane } from "./model-fields.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { AuthenticationPane, createProviderApiPane } from "./provider-fields.ts";
import { CURSOR, truncateMiddle, windowLines } from "./value-row.ts";

export interface ProviderEditorOptions {
	store: ModelsJsonStore;
	refresher: RefreshCoordinator;
	providerId: string;
	/** Session model at /provider open time; protects it and its provider from delete/rename. */
	currentModel?: { provider: string; id: string };
	runtime: CredentialRuntime & Pick<ModelRuntime, "getAuth">;
	notify: (message: string, type: "info" | "warning" | "error") => void;
}

export type ProviderEditorResult = "back" | "deleted";

type LeftItem =
	| { kind: "authentication" }
	| { kind: "fetch" }
	| { kind: "section"; label: "SETUP" | "MODELS" | "MANAGE" }
	| { kind: "model"; modelId: string }
	| { kind: "override"; modelId: string }
	| { kind: "builtinModels" }
	| { kind: "draft" }
	| { kind: "addModel" }
	| { kind: "deleteProvider" };

const LEFT_WIDTH_MIN = 16;
const LEFT_WIDTH_MAX = 40;
/** Fixed editor body height: both columns scroll inside it rather than resizing the frame. */
const BODY_ROWS = 14;
const DOUBLE_PANE_MIN_WIDTH = 72;
const MIN_WIDTH = 32;

function padTo(line: string, width: number): string {
	const missing = width - visibleWidth(line);
	return missing > 0 ? line + " ".repeat(missing) : line;
}

/** Stable identity across left-list rebuilds (a rename keeps the selection on the model). */
function leftItemKey(item: LeftItem | undefined): string {
	if (!item) return "";
	switch (item.kind) {
		case "model":
			return `model:${item.modelId}`;
		case "override":
			return `override:${item.modelId}`;
		case "section":
			return `section:${item.label}`;
		default:
			return item.kind;
	}
}

/** Removing a custom provider deletes its definition; removing a built-in's entry only resets it. */
const REMOVAL = {
	custom: {
		label: "Delete provider",
		verb: "delete",
		confirm: (id: string) => `Delete provider "${id}" from models.json? Stored credentials in auth.json are kept.`,
		info: ["Press Enter to delete this provider from models.json."],
	},
	builtin: {
		label: "Reset provider",
		verb: "reset",
		confirm: (id: string) => `Remove ${id} from models.json? Built-in models and credentials stay.`,
		info: [
			"Press Enter to remove this provider's models.json entry.",
			"Built-in models, endpoints, and stored credentials stay.",
		],
	},
} as const;

export class ProviderEditorScreen implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: ProviderEditorResult) => void;
	private readonly options: ProviderEditorOptions;
	private readonly host: EditorHost;

	private leftItems: LeftItem[] = [];
	private leftIndex = 0;
	private focusPane: "left" | "right" = "left";
	private stack: EditorPane[] = [];
	private draft: DraftModelHandle | undefined;
	private readonly edits: ProviderEdits;
	private fetchStatus: string | undefined;
	/** Built-in providers list the catalog behind Built-in models; custom ones discover through Fetch models. */
	private readonly builtin: boolean;
	/** The built-in catalog's model ids; empty for custom providers. */
	private readonly catalogIds: readonly string[];
	private readonly removal: (typeof REMOVAL)[keyof typeof REMOVAL];
	/** Created by this visit (not yet in models.json); abandoned leftovers are dropped on the way out. */
	private readonly fresh: boolean;
	private disposed = false;
	private _focused = false;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: ProviderEditorResult) => void,
		options: ProviderEditorOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.options = options;
		this.builtin = isBuiltinProviderId(options.providerId);
		this.catalogIds = this.builtin ? builtinModelIds(options.providerId) : [];
		this.removal = REMOVAL[this.builtin ? "builtin" : "custom"];
		this.edits = new ProviderEdits(options.store, options.providerId, options.refresher, () => this.refresh());
		this.host = this.createHost();
		this.rebuildLeftItems();
		this.leftIndex = this.selectableIndex(0);
		this.resetRightStack();
		this.fresh = !this.builtin && options.store.isDraftProvider(options.providerId);
		if (this.fresh && Object.keys(options.store.getProvider(options.providerId) ?? {}).length === 0)
			this.startSetup();
	}

	/** Every new provider starts the same way: the API picker (OpenAI-compatible suggested), then baseUrl, then apiKey. */
	private startSetup(): void {
		for (const pane of this.stack) pane.dispose?.();
		const auth = new AuthenticationPane(this.host, this.options.runtime);
		this.focusPane = "right";
		this.stack = [auth, createProviderApiPane(this.host, "openai-completions", () => auth.beginSetup())];
	}

	// ------------------------------------------------------------------
	// Component / Focusable
	// ------------------------------------------------------------------

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.topPane()?.setFocused(value && this.focusPane === "right");
	}

	invalidate(): void {
		this.cache = undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const pane of this.stack) pane.dispose?.();
		this.stack = [];
		// An unsubmitted draft never reaches disk; leaving the editor drops it.
		if (!hasProviderSettings(this.options.store.getProvider(this.options.providerId))) {
			this.options.store.discardProviderDraft(this.options.providerId);
		}
	}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const lines = this.renderFrame(width);
		this.cache = { width, lines };
		return lines;
	}

	handleInput(data: string): void {
		if (this.focusPane === "right") {
			const pane = this.topPane();
			if (pane && !pane.isEditing?.() && this.keybindings.matches(data, "app.provider.switchPaneLeft")) {
				pane.setFocused(false);
				this.focusPane = "left";
				this.refresh();
				return;
			}
			pane?.handleInput(data);
			return;
		}
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.moveLeft(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveLeft(1);
			return;
		}
		if (kb.matches(data, "app.provider.switchPaneRight")) {
			this.activateLeftItem("inspect");
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.activateLeftItem("activate");
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.leave();
	}

	/** Back to the list; a new provider holding only an API type or name reaches no request, so it is not kept. */
	private leave(): void {
		const provider = this.options.store.getProvider(this.options.providerId);
		if (this.fresh && provider && Object.keys(provider).length > 0 && !hasProviderSettings(provider))
			this.edits.removeProvider();
		this.done("back");
	}

	/** Rebuild from the store view after a save merged external changes. */
	syncFromStore(): void {
		if (this.disposed || this.edits.renaming) return;
		const selected = this.leftItems[this.leftIndex];
		const selectedKey = leftItemKey(selected);
		this.rebuildLeftItems();
		const nextIndex = this.leftItems.findIndex((item) => leftItemKey(item) === selectedKey);
		this.leftIndex =
			nextIndex >= 0
				? nextIndex
				: this.selectableIndex(Math.min(this.leftIndex, Math.max(0, this.leftItems.length - 1)));
		// If the selected model vanished externally, rebuild the right column.
		if (nextIndex < 0 && (selected?.kind === "model" || selected?.kind === "override")) {
			this.resetRightStack();
		}
		this.refresh();
	}

	// ------------------------------------------------------------------
	// Left column
	// ------------------------------------------------------------------

	private rebuildLeftItems(): void {
		const items: LeftItem[] = [{ kind: "section", label: "SETUP" }, { kind: "authentication" }];
		if (!this.builtin) items.push({ kind: "fetch" });
		items.push({ kind: "section", label: "MODELS" });
		for (const model of this.options.store.getModels(this.options.providerId)) {
			items.push({ kind: "model", modelId: model.id });
		}
		if (this.builtin) {
			// Only customized catalog models get a row; the full catalog stays behind Built-in models.
			const overrides = this.options.store.getProvider(this.options.providerId)?.modelOverrides ?? {};
			for (const modelId of this.catalogIds) {
				if (Object.hasOwn(overrides, modelId)) items.push({ kind: "override", modelId });
			}
			items.push({ kind: "builtinModels" });
		}
		if (this.draft) items.push({ kind: "draft" });
		items.push({ kind: "section", label: "MANAGE" }, { kind: "addModel" }, { kind: "deleteProvider" });
		this.leftItems = items;
	}

	private selectableIndex(start: number): number {
		const index = this.leftItems.findIndex((item, i) => i >= start && item.kind !== "section");
		return index >= 0 ? index : this.leftItems.findIndex((item) => item.kind !== "section");
	}

	private moveLeft(delta: number): void {
		const selectable = this.leftItems
			.map((item, index) => ({ item, index }))
			.filter((entry) => entry.item.kind !== "section");
		if (selectable.length === 0) return;
		const position = selectable.findIndex((entry) => entry.index === this.leftIndex);
		const next = selectable[(position + delta + selectable.length) % selectable.length]!;
		if (next.index === this.leftIndex) return;
		this.leftIndex = next.index;
		// Moving the left selection replaces the right column (cancels fetch/edit state).
		this.resetRightStack();
		this.refresh();
	}

	/**
	 * Enter activates the row; → only focuses its pane. Action rows therefore
	 * never fire from a focus move, matching their InfoPane's "Press Enter".
	 */
	private activateLeftItem(via: "activate" | "inspect"): void {
		const item = this.leftItems[this.leftIndex];
		if (!item) return;
		switch (item.kind) {
			case "authentication":
			case "model":
			case "override":
			case "builtinModels":
			case "draft":
				this.focusPane = "right";
				this.topPane()?.setFocused(this._focused);
				this.refresh();
				return;
			case "fetch":
				this.focusPane = "right";
				if (via === "activate") {
					const pane = this.topPane();
					if (pane instanceof FetchModelsPane) pane.start();
				}
				this.topPane()?.setFocused(this._focused);
				this.refresh();
				return;
			case "addModel": {
				if (via === "inspect") {
					this.focusPane = "right";
					this.topPane()?.setFocused(this._focused);
					this.refresh();
					return;
				}
				if (!this.draft) {
					this.draft = this.edits.draft();
					this.rebuildLeftItems();
				}
				const draftIndex = this.leftItems.findIndex((entry) => entry.kind === "draft");
				if (draftIndex >= 0) this.leftIndex = draftIndex;
				this.resetRightStack();
				this.focusPane = "right";
				const pane = this.topPane();
				pane?.setFocused(this._focused);
				if (pane instanceof ModelFieldsPane && !this.draft.read().id) pane.startEditingId();
				this.refresh();
				return;
			}
			case "deleteProvider": {
				if (via === "inspect") {
					this.focusPane = "right";
					this.topPane()?.setFocused(this._focused);
					this.refresh();
					return;
				}
				const current = this.options.currentModel;
				// Resetting a built-in provider keeps its catalog models; only models.json-defined ones disappear.
				const currentLost =
					current?.provider === this.options.providerId &&
					(!this.builtin || this.options.store.getModel(current.provider, current.id) !== undefined);
				if (currentLost) {
					this.host.notify(
						`The current model is defined here, so the provider cannot be ${this.removal.verb}; switch models with /model first.`,
						"error",
					);
					return;
				}
				if (
					this.builtin &&
					Object.keys(this.options.store.getProvider(this.options.providerId) ?? {}).length === 0
				) {
					this.host.notify(`${this.options.providerId} has no customizations to reset.`, "info");
					return;
				}
				this.host.confirm(this.removal.confirm(this.options.providerId), this.removal.label, () => {
					this.edits.removeProvider();
					this.done("deleted");
				});
				return;
			}
			default:
				return;
		}
	}

	private renderLeft(width: number): string[] {
		const theme = this.theme;
		const focused = this.focusPane === "left";
		const rows: string[] = [];
		const renderRow = (index: number): string => {
			const item = this.leftItems[index]!;
			if (item.kind === "section") {
				return theme.fg("dim", item.label);
			}
			return this.renderLeftItem(item, index === this.leftIndex, focused, width);
		};
		if (this.leftItems.length <= BODY_ROWS) {
			for (let index = 0; index < this.leftItems.length; index++) rows.push(renderRow(index));
		} else {
			// One row carries the (n/N) position indicator, like the /model selector.
			const slots = BODY_ROWS - 1;
			const start = Math.max(0, Math.min(this.leftIndex - Math.floor(slots / 2), this.leftItems.length - slots));
			for (let index = start; index < start + slots; index++) rows.push(renderRow(index));
			const selectable: LeftItem[] = this.leftItems.filter((item) => item.kind !== "section");
			const position = selectable.indexOf(this.leftItems[this.leftIndex]!);
			rows.push(theme.fg("dim", `  (${position + 1}/${selectable.length})`));
		}
		while (rows.length < BODY_ROWS) rows.push("");
		return rows;
	}

	private leftItemContent(item: LeftItem): { text: string; note?: string; dim: boolean } {
		const store = this.options.store;
		let text: string;
		let note: string | undefined;
		switch (item.kind) {
			case "authentication":
				text = "Authentication";
				break;
			case "fetch":
				text = "Fetch models";
				note = this.fetchStatus;
				break;
			case "model": {
				const model = store.getModel(this.options.providerId, item.modelId);
				text = model ? modelDisplayName(model) : item.modelId;
				if (this.builtin) note = this.catalogIds.includes(item.modelId) ? "· replaced" : "· custom";
				break;
			}
			case "override": {
				const own = store.getProvider(this.options.providerId)?.modelOverrides?.[item.modelId];
				text = builtinModelFields(this.options.providerId, item.modelId, own)?.name ?? item.modelId;
				break;
			}
			case "builtinModels":
				text = "Built-in models";
				note = `· ${this.catalogIds.length}`;
				break;
			case "draft": {
				text = this.draft?.read().name ?? this.draft?.read().id ?? "New model";
				note = "· draft";
				break;
			}
			case "addModel":
				text = "+ Add model";
				break;
			case "deleteProvider":
				text = this.removal.label;
				break;
			default:
				text = "";
		}
		const dim = item.kind === "draft" && !this.draft?.read().name && !this.draft?.read().id;
		return { text, note, dim };
	}

	private renderLeftItem(item: LeftItem, active: boolean, focused: boolean, width: number): string {
		const theme = this.theme;
		// Single-accent focus rule: the marker and accent exist only in the
		// focused column; an unfocused column keeps its content plain.
		const lit = active && focused;
		const marker = lit ? theme.fg("accent", `${CURSOR} `) : "  ";
		const style = (text: string, dim = false) => theme.fg(lit ? "accent" : dim ? "dim" : "text", text);
		const { text: label, note, dim } = this.leftItemContent(item);
		let text = label;
		// Long model names keep head and tail (the distinctive parts) instead of a hard cut.
		if (item.kind === "model" || item.kind === "override" || item.kind === "draft") {
			const budget = Math.max(8, width - 2 - (note ? visibleWidth(note) + 1 : 0));
			text = truncateMiddle(text, budget);
		}
		const noteText = note ? theme.fg("dim", ` ${note}`) : "";
		return truncateToWidth(marker + style(text, dim) + noteText, width);
	}

	// ------------------------------------------------------------------
	// Right column (pane stack)
	// ------------------------------------------------------------------

	private topPane(): EditorPane | undefined {
		return this.stack[this.stack.length - 1];
	}

	private pushPane(pane: EditorPane): void {
		this.topPane()?.setFocused(false);
		this.focusPane = "right";
		this.stack.push(pane);
		pane.setFocused(this._focused && this.focusPane === "right");
		this.refresh();
	}

	private popPane(): void {
		if (this.stack.length <= 1) {
			// Esc on the base pane moves focus back to the left column.
			this.topPane()?.setFocused(false);
			this.focusPane = "left";
			this.refresh();
			return;
		}
		const pane = this.stack.pop();
		pane?.setFocused(false);
		pane?.dispose?.();
		this.topPane()?.setFocused(this._focused && this.focusPane === "right");
		this.refresh();
	}

	private resetRightStack(): void {
		for (const pane of this.stack) pane.dispose?.();
		const item = this.leftItems[this.leftIndex];
		this.stack = [this.createBasePane(item)];
		this.topPane()?.setFocused(this._focused && this.focusPane === "right");
	}

	private createBasePane(item: LeftItem | undefined): EditorPane {
		switch (item?.kind) {
			case "authentication":
				return new AuthenticationPane(this.host, this.options.runtime);
			case "fetch":
				return new FetchModelsPane(this.host);
			case "model":
				return new ModelFieldsPane(this.host, this.persistedHandle(item.modelId));
			case "override":
				return new ModelFieldsPane(this.host, this.edits.override(item.modelId));
			case "builtinModels":
				return new BuiltinModelsPane(this.host);
			case "draft":
				return new ModelFieldsPane(this.host, this.draft!);
			case "addModel":
				return new InfoPane(
					this.host,
					[
						"Press Enter to create a model.",
						"The draft is saved once its id is set.",
						"Esc on the draft discards it.",
					],
					() => this.activateLeftItem("activate"),
				);
			case "deleteProvider":
				return new InfoPane(this.host, [...this.removal.info], () => this.activateLeftItem("activate"));
			default:
				return new InfoPane(this.host, []);
		}
	}

	private persistedHandle(modelId: string): ModelHandle {
		return this.edits.model(modelId, (oldId, newId) => {
			const selected = this.leftItems[this.leftIndex];
			if (selected?.kind === "model" && selected.modelId === oldId) selected.modelId = newId;
			this.syncFromStore();
		});
	}

	// ------------------------------------------------------------------
	// EditorHost implementation
	// ------------------------------------------------------------------

	private createHost(): EditorHost {
		const store = this.options.store;
		const providerId = this.options.providerId;
		return {
			theme: this.theme,
			keybindings: this.keybindings,
			store,
			edits: this.edits,
			providerId,
			pushPane: (pane) => this.pushPane(pane),
			popPane: () => this.popPane(),
			refresh: () => this.refresh(),
			notify: (message, type) => this.options.notify(message, type),
			effectiveApi: (model) => {
				return effectiveModelSettings(providerId, store.getProvider(providerId), model).api;
			},
			effectiveBaseUrl: (model) => {
				return effectiveModelSettings(providerId, store.getProvider(providerId), model).baseUrl;
			},
			commitModelDraft: () => this.commitModelDraft(),
			discardModelDraft: () => this.discardModelDraft(),
			isCurrentModel: (modelId) =>
				this.options.currentModel?.provider === providerId && this.options.currentModel.id === modelId,
			setFetchStatus: (status) => {
				this.fetchStatus = status;
				this.refresh();
			},
			runFetch: (signal) => fetchProviderModels(this.options, signal),
			importModels: async (models, signal) => {
				const error = await importProviderModels({ ...this.options, edits: this.edits }, models, signal);
				if (!this.disposed) this.syncFromStore();
				return error;
			},
			openOverride: (modelId) => this.pushPane(new ModelFieldsPane(this.host, this.edits.override(modelId))),
			confirm: (message, actionLabel, action) =>
				this.pushPane(new ConfirmPane(this.host, message, actionLabel, action)),
			onModelRemoved: () => {
				this.rebuildLeftItems();
				// Land on the next row where the model was; walk back over section labels.
				this.leftIndex = Math.min(this.leftIndex, this.leftItems.length - 1);
				while (this.leftIndex > 0 && this.leftItems[this.leftIndex]?.kind === "section") this.leftIndex--;
				if (this.leftItems[this.leftIndex]?.kind === "section") this.leftIndex = this.selectableIndex(0);
				this.focusPane = "left";
				this.resetRightStack();
				this.refresh();
			},
		};
	}

	/** Drop the in-memory draft: the selection returns to + Add Model with focus on the left. */
	private discardModelDraft(): void {
		if (!this.draft) return;
		this.draft = undefined;
		this.rebuildLeftItems();
		const addIndex = this.leftItems.findIndex((item) => item.kind === "addModel");
		this.leftIndex = addIndex >= 0 ? addIndex : this.selectableIndex(0);
		this.focusPane = "left";
		this.resetRightStack();
		this.refresh();
	}

	private commitModelDraft(): string | undefined {
		const draft = this.draft;
		if (!draft) return "No model draft.";
		const error = this.edits.commitDraft(draft);
		if (error) return error;
		const id = draft.read().id!.trim();
		this.draft = undefined;
		this.rebuildLeftItems();
		const index = this.leftItems.findIndex((item) => item.kind === "model" && item.modelId === id);
		if (index >= 0) this.leftIndex = index;
		this.resetRightStack();
		this.refresh();
		return undefined;
	}

	// ------------------------------------------------------------------
	// Frame rendering
	// ------------------------------------------------------------------

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private renderFrame(width: number): string[] {
		const theme = this.theme;
		const border = new DynamicBorder((text) => theme.fg("border", text)).render(width)[0]!;
		if (width < MIN_WIDTH) {
			return [
				border,
				truncateToWidth(theme.fg("warning", ` /provider needs at least ${MIN_WIDTH} columns`), width),
				border,
			];
		}
		const title = this.renderTitle(width);
		let body: string[];
		if (width < DOUBLE_PANE_MIN_WIDTH) {
			body = this.focusPane === "left" ? this.renderLeft(width) : this.renderRight(width);
		} else {
			const leftWidth = this.computeLeftWidth(width);
			const rightWidth = width - leftWidth - 3;
			const separator = theme.fg("border", " │ ");
			const leftLines = this.renderLeft(leftWidth);
			const rightLines = this.renderRight(rightWidth);
			body = [];
			for (let row = 0; row < BODY_ROWS; row++) {
				const left = padTo(truncateToWidth(leftLines[row] ?? "", leftWidth), leftWidth);
				const right = truncateToWidth(rightLines[row] ?? "", rightWidth);
				body.push(left + separator + right);
			}
		}

		const footerLines = this.renderFooter(width);
		return [border, title, border, ...body, border, ...footerLines, border];
	}

	private renderRight(width: number): string[] {
		const pane = this.topPane();
		const paneLines = pane ? windowLines(this.theme, pane.render(width), BODY_ROWS - 1, pane.scrollWindow?.()) : [];
		return [this.renderPaneTitle(width), ...paneLines];
	}

	private renderPaneTitle(width: number): string {
		const item = this.leftItems[this.leftIndex];
		let base = "";
		switch (item?.kind) {
			case "authentication":
				base = "Authentication";
				break;
			case "fetch":
				base = "Fetch models";
				break;
			case "model": {
				const model = this.options.store.getModel(this.options.providerId, item.modelId);
				base = model ? modelDisplayName(model) : item.modelId;
				break;
			}
			case "override":
				base = this.leftItemContent(item).text;
				break;
			case "builtinModels":
				base = "Built-in models";
				break;
			case "draft":
				base = "New model";
				break;
			case "addModel":
				base = "Add model";
				break;
			case "deleteProvider":
				base = this.removal.label;
				break;
		}
		// Pushed pages with a heading stay named under the sub-panes above them: "Built-in models / GPT-5 / cost".
		const pushed = this.stack.slice(1);
		const headings = pushed.map((pane) => pane.heading);
		const top = pushed.at(-1);
		const title = [base, ...headings, top?.heading ? undefined : top?.crumb].filter(Boolean).join(" / ");
		return truncateToWidth(this.theme.fg("text", this.theme.bold(title)), width);
	}

	/** Content-driven left width: fits the longest visible label, clamped to 16–40 and 45% of the terminal. */
	private computeLeftWidth(width: number): number {
		let longest = 12;
		for (const item of this.leftItems) {
			if (item.kind === "section") continue;
			const { text, note } = this.leftItemContent(item);
			const label = text + (note ? ` ${note}` : "");
			longest = Math.max(longest, visibleWidth(label));
		}
		const fit = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, longest + 2));
		return Math.min(fit, Math.max(LEFT_WIDTH_MIN, Math.floor(width * 0.45)));
	}

	private renderTitle(width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(` Providers / ${this.options.providerId}`));
		const status =
			this.options.store.writableCount === 0 ? "" : this.options.store.saveFailed ? "Save failed" : "Saving…";
		if (!status) return truncateToWidth(title, width);
		const styledStatus = theme.fg(this.options.store.saveFailed ? "error" : "dim", status);
		const statusWidth = visibleWidth(status);
		if (statusWidth + 1 >= width) return truncateToWidth(styledStatus, width);
		const left = truncateToWidth(title, width - statusWidth - 1);
		return padTo(left, width - statusWidth) + styledStatus;
	}

	/** Default arrow bindings read as ← / →, like Pi core's ↑↓; a rebound key shows its own name. */
	private arrowHint(binding: "app.provider.switchPaneLeft" | "app.provider.switchPaneRight", label: string): string {
		const keys = this.keybindings.getKeys(binding);
		const glyph = binding === "app.provider.switchPaneLeft" ? "←" : "→";
		const arrow = binding === "app.provider.switchPaneLeft" ? "left" : "right";
		return keys.length === 1 && keys[0] === arrow ? rawKeyHint(glyph, label) : keyHint(binding, label);
	}

	private renderFooter(width: number): string[] {
		if (this.focusPane === "right") {
			const pane = this.topPane();
			const paneHints = pane?.hints() ?? "";
			// ← moves the text cursor while a field is open, so the way-back hint waits until it closes.
			if (pane?.isEditing?.()) return [truncateToWidth(paneHints, width)];
			if (width < DOUBLE_PANE_MIN_WIDTH) {
				// Esc already returns to navigation here; only add the arrow hint when it fits whole.
				const arrowHint = this.arrowHint("app.provider.switchPaneLeft", "nav");
				const combined = [paneHints, arrowHint].filter(Boolean).join("  ");
				return [truncateToWidth(visibleWidth(combined) <= width ? combined : paneHints, width)];
			}
			// The editor owns the way-back hint so every wide-layout pane footer is consistent.
			const hints = [paneHints, this.arrowHint("app.provider.switchPaneLeft", "back to list")]
				.filter(Boolean)
				.join("  ");
			return [truncateToWidth(hints, width)];
		}
		const hints = [
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", this.leftActivateLabel()),
			this.arrowHint("app.provider.switchPaneRight", "details"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
		return [truncateToWidth(hints, width)];
	}

	/** What Enter does to the selected left-column row, so the footer never lies about action rows. */
	private leftActivateLabel(): string {
		switch (this.leftItems[this.leftIndex]?.kind) {
			case "fetch":
				return "fetch";
			case "addModel":
				return "create";
			case "deleteProvider":
				return this.removal.verb;
			default:
				return "open";
		}
	}
}

function modelDisplayName(model: ModelsJsonModel): string {
	return model.name ?? model.id;
}
