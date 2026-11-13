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
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { builtinModelFields, builtinModelIds, isBuiltinProviderId } from "../catalog.ts";
import { effectiveModelSettings, hasProviderSettings } from "../configuration.ts";
import { fetchProviderModels, importProviderModels } from "../connection.ts";
import { API_TYPES } from "../constants.ts";
import { type DraftModelHandle, ProviderEdits } from "../editing.ts";
import type { RefreshCoordinator } from "../refresh.ts";
import type { ModelsJsonStore } from "../store.ts";
import { BuiltinModelsPane } from "./builtin-models.ts";
import type { CredentialRuntime } from "./credential.ts";
import { ConfirmPane, InfoPane } from "./dialogs.ts";
import { FetchModelsPane } from "./fetch-models.ts";
import { ModelFieldsPane } from "./model-fields.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { AuthenticationPane, createProviderApiPane, type SetupOutcome } from "./provider-fields.ts";
import { CURSOR, frameBodyRows, truncateMiddle, windowLines } from "./value-row.ts";

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

/** A selectable left-column row: everything the editor shows, opens, and runs for it. */
interface LeftRow {
	/** Stable identity across rebuilds, so a store sync or a rename keeps the selection. */
	readonly key: string;
	/** Long model names keep head and tail (the distinctive parts) instead of a hard cut. */
	readonly middleTruncate?: boolean;
	label(): { text: string; note?: string; dim?: boolean };
	/** Right-column title; the label text when omitted. */
	title?(): string;
	/** The right column's base pane while the row is selected. */
	pane(): EditorPane;
	/** What Enter runs instead of focusing the pane; → only ever focuses it. */
	readonly action?: { readonly verb: string; run(): void };
	/** What the remove key does to the row's entry, behind a confirm. */
	readonly remove?: { readonly verb: string; run(): void };
}

type LeftItem = LeftRow | { readonly section: string };

function isRow(item: LeftItem | undefined): item is LeftRow {
	return item !== undefined && !("section" in item);
}

const modelKey = (modelId: string) => `model:${modelId}`;

const LEFT_WIDTH_MIN = 16;
const LEFT_WIDTH_MAX = 32;
const DOUBLE_PANE_MIN_WIDTH = 72;
const MIN_WIDTH = 32;

function padTo(line: string, width: number): string {
	const missing = width - visibleWidth(line);
	return missing > 0 ? line + " ".repeat(missing) : line;
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
	private disposed = false;
	private _focused = false;
	/** Stack depth to hand focus back to the left column at: a confirm opened from there returns there. */
	private returnLeftAt: number | undefined;
	private cache: { width: number; rows: number; lines: string[] } | undefined;

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
		const fresh = !this.builtin && options.store.isDraftProvider(options.providerId);
		if (fresh && Object.keys(options.store.getProvider(options.providerId) ?? {}).length === 0) this.startSetup();
	}

	/**
	 * Every new provider starts the same way: the API picker, then baseUrl, then
	 * apiKey, then the endpoint's model list, so one pass ends on models to import.
	 */
	private startSetup(): void {
		for (const pane of this.stack) pane.dispose?.();
		const auth = new AuthenticationPane(this.host, this.options.runtime);
		this.focusPane = "right";
		const picker = createProviderApiPane(this.host, API_TYPES[0], () =>
			auth.beginSetup((outcome) => this.fetchAfterSetup(outcome)),
		);
		this.stack = [auth, picker];
	}

	/**
	 * A key entered with Enter carries on into the request. Esc on apiKey only
	 * lands on Fetch models, one Enter away: a cancel key should not send one.
	 */
	private fetchAfterSetup(outcome: SetupOutcome): void {
		if (this.disposed || !this.select("fetch")) return;
		this.resetRightStack();
		if (outcome === "entered") this.selectedRow()?.action?.run();
		else this.focusRight();
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
		// A draft not worth writing (an untouched built-in, or a new provider holding only
		// an API type or name) was never saved; leaving the editor drops it.
		const { store, providerId } = this.options;
		if (!hasProviderSettings(providerId, store.getProvider(providerId))) store.discardProviderDraft(providerId);
	}

	/** Body height both columns scroll inside; it follows the terminal height, never the content. */
	private bodyRows(): number {
		return frameBodyRows(this.tui);
	}

	render(width: number): string[] {
		const rows = this.bodyRows();
		if (this.cache && this.cache.width === width && this.cache.rows === rows) return this.cache.lines;
		const lines = this.renderFrame(width);
		this.cache = { width, rows, lines };
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
		if (kb.matches(data, "app.provider.removeEntry")) {
			this.selectedRow()?.remove?.run();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.done("back");
	}

	/**
	 * Rebuild from the store view after a save merged external changes.
	 * `selectKey` names the row to keep selected, e.g. a renamed model's new key.
	 */
	syncFromStore(selectKey = this.selectedRow()?.key): void {
		if (this.disposed || this.edits.renaming) return;
		this.rebuildLeftItems();
		if (!this.select(selectKey)) {
			// The selected row vanished (its model was removed or reset elsewhere): land nearby, rebuild the right column.
			this.leftIndex = this.selectableIndex(Math.min(this.leftIndex, this.leftItems.length - 1));
			this.resetRightStack();
		}
		this.refresh();
	}

	// ------------------------------------------------------------------
	// Left column
	// ------------------------------------------------------------------

	private rebuildLeftItems(): void {
		const { store, providerId } = this.options;
		const items: LeftItem[] = [{ section: "SETUP" }, this.authenticationRow()];
		if (!this.builtin) items.push(this.fetchRow());
		const models = store.getModels(providerId);
		// An empty section says so, instead of reading as a rendering gap above MANAGE.
		items.push({ section: this.builtin || models.length > 0 || this.draft ? "MODELS" : "MODELS · none yet" });
		for (const model of models) items.push(this.modelRow(model.id));
		if (this.builtin) {
			// Only customized catalog models get a row; the full catalog stays behind Built-in models.
			const overrides = store.getProvider(providerId)?.modelOverrides ?? {};
			for (const modelId of this.catalogIds) {
				if (Object.hasOwn(overrides, modelId)) items.push(this.overrideRow(modelId));
			}
			items.push(this.builtinModelsRow());
		}
		if (this.draft) items.push(this.draftRow(this.draft));
		items.push({ section: "MANAGE" }, this.addModelRow(), this.removalRow());
		this.leftItems = items;
	}

	private authenticationRow(): LeftRow {
		return {
			key: "authentication",
			label: () => ({ text: "Authentication" }),
			pane: () => new AuthenticationPane(this.host, this.options.runtime),
		};
	}

	private fetchRow(): LeftRow {
		return {
			key: "fetch",
			label: () => ({ text: "Fetch models", note: this.fetchStatus }),
			pane: () => new FetchModelsPane(this.host),
			action: {
				verb: "fetch",
				run: () => {
					const pane = this.topPane();
					if (pane instanceof FetchModelsPane) pane.start();
					this.focusRight();
				},
			},
		};
	}

	private modelRow(modelId: string): LeftRow {
		const { store, providerId } = this.options;
		return {
			key: modelKey(modelId),
			middleTruncate: true,
			label: () => {
				const model = store.getModel(providerId, modelId);
				// On a built-in provider, a models.json model either replaces a catalog entry or adds one.
				const origin = this.catalogIds.includes(modelId) ? "replaced" : "custom";
				// The session's model is protected from delete and rename, so the row says which one it is.
				const notes = [this.builtin ? origin : "", this.host.isCurrentModel(modelId) ? "in use" : ""].filter(
					Boolean,
				);
				return {
					text: model ? (model.name ?? model.id) : modelId,
					note: notes.length > 0 ? `· ${notes.join(" · ")}` : undefined,
				};
			},
			remove: { verb: "delete", run: () => this.removeModel(modelId) },
			pane: () =>
				new ModelFieldsPane(
					this.host,
					this.edits.model(modelId, (oldId, newId) => {
						// Follow the rename only when the selection still sits on the model.
						const follow = this.selectedRow()?.key === modelKey(oldId);
						this.syncFromStore(follow ? modelKey(newId) : undefined);
					}),
				),
		};
	}

	private overrideRow(modelId: string): LeftRow {
		const { store, providerId } = this.options;
		return {
			key: `override:${modelId}`,
			middleTruncate: true,
			label: () => {
				const own = store.getProvider(providerId)?.modelOverrides?.[modelId];
				return { text: builtinModelFields(providerId, modelId, own)?.name ?? modelId };
			},
			pane: () => new ModelFieldsPane(this.host, this.edits.override(modelId)),
			remove: { verb: "reset", run: () => this.resetOverride(modelId) },
		};
	}

	private builtinModelsRow(): LeftRow {
		return {
			key: "builtinModels",
			label: () => ({ text: "Built-in models", note: `· ${this.catalogIds.length}` }),
			pane: () => new BuiltinModelsPane(this.host),
		};
	}

	private draftRow(draft: DraftModelHandle): LeftRow {
		return {
			key: "draft",
			middleTruncate: true,
			label: () => {
				const { name, id } = draft.read();
				return { text: name ?? id ?? "New model", note: "· draft", dim: !name && !id };
			},
			title: () => "New model",
			pane: () => new ModelFieldsPane(this.host, draft),
		};
	}

	/** Enter on the row or on its explanation pane starts a model draft. */
	private addModelRow(): LeftRow {
		const run = () => this.addModel();
		return {
			key: "addModel",
			label: () => ({ text: "+ Add model" }),
			title: () => "Add model",
			pane: () =>
				new InfoPane(
					this.host,
					[
						"Press Enter to create a model.",
						"The draft is saved once its id is set.",
						"Esc on the draft discards it.",
					],
					run,
				),
			action: { verb: "create", run },
		};
	}

	/** Enter on the row or on its explanation pane deletes a custom provider or resets a built-in one. */
	private removalRow(): LeftRow {
		const run = () => this.removeProvider();
		return {
			key: "removeProvider",
			label: () => ({ text: this.removal.label }),
			pane: () => new InfoPane(this.host, [...this.removal.info], run),
			action: { verb: this.removal.verb, run },
		};
	}

	private selectedRow(): LeftRow | undefined {
		const item = this.leftItems[this.leftIndex];
		return isRow(item) ? item : undefined;
	}

	/** Select the row with `key`; false when no row has it. */
	private select(key: string | undefined): boolean {
		const index = this.leftItems.findIndex((item) => isRow(item) && item.key === key);
		if (index >= 0) this.leftIndex = index;
		return index >= 0;
	}

	private selectableIndex(start: number): number {
		const index = this.leftItems.findIndex((item, i) => i >= start && isRow(item));
		return index >= 0 ? index : this.leftItems.findIndex(isRow);
	}

	private moveLeft(delta: number): void {
		const selectable = this.leftItems.map((item, index) => ({ item, index })).filter((entry) => isRow(entry.item));
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
	 * Enter runs the row's action; → only focuses its pane. Action rows therefore
	 * never fire from a focus move, matching their InfoPane's "Press Enter".
	 */
	private activateLeftItem(via: "activate" | "inspect"): void {
		const row = this.selectedRow();
		if (via === "activate" && row?.action) row.action.run();
		else if (row) this.focusRight();
	}

	private focusRight(): void {
		this.focusPane = "right";
		this.topPane()?.setFocused(this._focused);
		this.refresh();
	}

	private addModel(): void {
		if (!this.draft) {
			this.draft = this.edits.draft();
			this.rebuildLeftItems();
		}
		this.select("draft");
		this.resetRightStack();
		this.focusRight();
		const pane = this.topPane();
		if (pane instanceof ModelFieldsPane && !this.draft.read().id) pane.startEditingId();
	}

	/** Delete a models.json model behind a confirm; the session's model is refused. */
	private removeModel(modelId: string): void {
		if (this.host.isCurrentModel(modelId)) {
			this.host.notify("The current model cannot be deleted; switch models with /model first.", "error");
			return;
		}
		this.host.confirm(`Delete model "${modelId}" from ${this.options.providerId}?`, "Delete model", () => {
			this.edits.removeModel(modelId);
			this.landAfterRemoval();
		});
	}

	/** Drop a catalog model's whole modelOverrides entry behind a confirm. */
	private resetOverride(modelId: string): void {
		this.host.confirm(
			`Remove every override of "${modelId}"? The built-in values return.`,
			"Reset to built-in",
			() => {
				this.edits.override(modelId).reset();
				this.landAfterRemoval();
			},
		);
	}

	/** A model row just went away: rebuild, land on the row that took its place, and return to navigation. */
	private landAfterRemoval(): void {
		this.rebuildLeftItems();
		this.leftIndex = Math.min(this.leftIndex, this.leftItems.length - 1);
		// Walk back over section labels.
		while (this.leftIndex > 0 && !isRow(this.leftItems[this.leftIndex])) this.leftIndex--;
		if (!isRow(this.leftItems[this.leftIndex])) this.leftIndex = this.selectableIndex(0);
		this.focusPane = "left";
		this.resetRightStack();
		this.refresh();
	}

	private removeProvider(): void {
		const { store, providerId, currentModel: current } = this.options;
		// Resetting a built-in provider keeps its catalog models; only models.json-defined ones disappear.
		const currentLost =
			current?.provider === providerId && (!this.builtin || store.getModel(providerId, current.id) !== undefined);
		if (currentLost) {
			this.host.notify(
				`The current model is defined here, so the provider cannot be ${this.removal.verb}; switch models with /model first.`,
				"error",
			);
			return;
		}
		if (this.builtin && Object.keys(store.getProvider(providerId) ?? {}).length === 0) {
			this.host.notify(`${providerId} has no customizations to reset.`, "info");
			return;
		}
		this.host.confirm(this.removal.confirm(providerId), this.removal.label, () => {
			this.edits.removeProvider();
			this.done("deleted");
		});
	}

	private renderLeft(width: number): string[] {
		const theme = this.theme;
		const focused = this.focusPane === "left";
		const rows: string[] = [];
		const renderRow = (index: number): string => {
			const item = this.leftItems[index];
			return isRow(item)
				? this.renderLeftItem(item, index === this.leftIndex, focused, width)
				: theme.fg("dim", item!.section);
		};
		const bodyRows = this.bodyRows();
		if (this.leftItems.length <= bodyRows) {
			for (let index = 0; index < this.leftItems.length; index++) rows.push(renderRow(index));
		} else {
			// One row carries the (n/N) position indicator, like the /model selector.
			const slots = bodyRows - 1;
			const start = Math.max(0, Math.min(this.leftIndex - Math.floor(slots / 2), this.leftItems.length - slots));
			for (let index = start; index < start + slots; index++) rows.push(renderRow(index));
			const selectable: LeftItem[] = this.leftItems.filter(isRow);
			const position = selectable.indexOf(this.leftItems[this.leftIndex]!);
			rows.push(theme.fg("dim", `  (${position + 1}/${selectable.length})`));
		}
		while (rows.length < bodyRows) rows.push("");
		return rows;
	}

	private renderLeftItem(row: LeftRow, active: boolean, focused: boolean, width: number): string {
		const theme = this.theme;
		// Single-accent focus rule: the marker and accent exist only in the
		// focused column; an unfocused column keeps its content plain.
		const lit = active && focused;
		const marker = lit ? theme.fg("accent", `${CURSOR} `) : "  ";
		const style = (text: string, dim = false) => theme.fg(lit ? "accent" : dim ? "dim" : "text", text);
		const { text: label, note, dim } = row.label();
		let text = label;
		if (row.middleTruncate) {
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
		if (this.returnLeftAt === this.stack.length) {
			this.returnLeftAt = undefined;
			this.focusPane = "left";
		}
		this.topPane()?.setFocused(this._focused && this.focusPane === "right");
		this.refresh();
	}

	private resetRightStack(): void {
		for (const pane of this.stack) pane.dispose?.();
		this.returnLeftAt = undefined;
		this.stack = [this.selectedRow()?.pane() ?? new InfoPane(this.host, [])];
		this.topPane()?.setFocused(this._focused && this.focusPane === "right");
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
			confirm: (message, actionLabel, action) => {
				if (this.focusPane === "left") this.returnLeftAt = this.stack.length;
				this.pushPane(new ConfirmPane(this.host, message, actionLabel, action));
			},
			removeModel: (modelId) => this.removeModel(modelId),
		};
	}

	/** Drop the in-memory draft: the selection returns to + Add Model with focus on the left. */
	private discardModelDraft(): void {
		if (!this.draft) return;
		this.draft = undefined;
		this.rebuildLeftItems();
		this.select("addModel");
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
		this.select(modelKey(id));
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
		const bodyRows = this.bodyRows();
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
			for (let row = 0; row < bodyRows; row++) {
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
		const paneLines = pane
			? windowLines(this.theme, pane.render(width), this.bodyRows() - 1, pane.scrollWindow?.())
			: [];
		return [this.renderPaneTitle(width), ...paneLines];
	}

	private renderPaneTitle(width: number): string {
		const row = this.selectedRow();
		const base = row ? (row.title?.() ?? row.label().text) : "";
		// Pushed pages with a heading stay named under the sub-panes above them: "Built-in models / GPT-5 / cost".
		const pushed = this.stack.slice(1);
		const headings = pushed.map((pane) => pane.heading);
		const top = pushed.at(-1);
		const title = [base, ...headings, top?.heading ? undefined : top?.crumb].filter(Boolean).join(" / ");
		return truncateToWidth(this.theme.fg("text", this.theme.bold(title)), width);
	}

	/** Content-driven left width: fits the longest visible label, clamped to 16–32 and 40% of the terminal. */
	private computeLeftWidth(width: number): number {
		let longest = 12;
		for (const item of this.leftItems) {
			if (!isRow(item)) continue;
			const { text, note } = item.label();
			const label = text + (note ? ` ${note}` : "");
			longest = Math.max(longest, visibleWidth(label));
		}
		const fit = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, longest + 2));
		return Math.min(fit, Math.max(LEFT_WIDTH_MIN, Math.floor(width * 0.4)));
	}

	private renderTitle(width: number): string {
		const theme = this.theme;
		const title = theme.fg("accent", theme.bold(` Providers / ${this.options.providerId}`));
		const store = this.options.store;
		// Edits save as they are made, so the title says where the last one stands.
		const writing = store.writableCount > 0;
		// Edits held back (a new provider that cannot reach a request yet) are pending but not written, so not "Saved".
		const saved = this.edits.edited && store.pendingCount === 0;
		const status = writing ? (store.saveFailed ? "Save failed" : "Saving…") : saved ? "Saved" : "";
		if (!status) return truncateToWidth(title, width);
		const styledStatus = theme.fg(status === "Save failed" ? "error" : "dim", status);
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
		const row = this.selectedRow();
		const hints = [
			rawKeyHint("↑↓", "navigate"),
			// What Enter does to the selected row, so the footer never lies about action rows.
			keyHint("tui.select.confirm", row?.action?.verb ?? "open"),
			// → only differs from Enter on an action row, where it shows the explanation without running it.
			row?.action ? this.arrowHint("app.provider.switchPaneRight", "details") : "",
			row?.remove ? keyHint("app.provider.removeEntry", row.remove.verb) : "",
			keyHint("tui.select.cancel", "back"),
		]
			.filter(Boolean)
			.join("  ");
		return [truncateToWidth(hints, width)];
	}
}
