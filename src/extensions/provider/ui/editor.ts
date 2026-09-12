/**
 * Two-pane provider editor.
 *
 * Left column: Authentication / API Type / Fetch Models, the provider's
 * models (name → id → "New Model" fallback, one draft at a time), then
 * + Add Model and Delete Provider. Right column hosts the selected item's
 * field pane and sub-pane stack; both columns keep their own selection and
 * scroll position. The frame height is fixed: each column scrolls inside a
 * fixed window with a (n/N) position indicator instead of resizing, and the
 * selected row stays accent in both panes while the unfocused pane's other
 * rows dim back. Typing on a value row overwrites, Enter tweaks or enters,
 * ←/→ switch panes, Esc cancels/pops/backs out.
 */

import { type Component, type Focusable, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { isBuiltinProviderId } from "../catalog.ts";
import { effectiveModelSettings, hasProviderSettings } from "../configuration.ts";
import { fetchProviderModels, importProviderModels } from "../connection.ts";
import type { RefreshCoordinator } from "../refresh.ts";
import { DELETE, type ModelsJsonStore } from "../store.ts";
import { ConfirmPane, InfoPane } from "./dialogs.ts";
import { FetchModelsPane } from "./fetch-models.ts";
import { ModelFieldsPane } from "./model-fields.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { ApiTypePane, AuthPane } from "./provider-fields.ts";
import { CURSOR, truncateMiddle, windowLines } from "./value-row.ts";

export interface ProviderEditorOptions {
	store: ModelsJsonStore;
	refresher: RefreshCoordinator;
	providerId: string;
	/** Session model at /provider open time; protects it and its provider from delete/rename. */
	currentModel?: { provider: string; id: string };
	registry: Pick<ModelRegistry, "getProviderAuthStatus">;
	runtime: Pick<ModelRuntime, "getAuth" | "getProviderAuthStatus">;
	notify: (message: string, type: "info" | "warning" | "error") => void;
}

export type ProviderEditorResult = "back" | "deleted";

type LeftItem =
	| { kind: "authentication" }
	| { kind: "apiType" }
	| { kind: "fetch" }
	| { kind: "separator" }
	| { kind: "model"; modelId: string }
	| { kind: "draft" }
	| { kind: "addModel" }
	| { kind: "deleteProvider" };

const LEFT_WIDTH_MIN = 16;
const LEFT_WIDTH_MAX = 40;
/** Fixed editor body height: both columns scroll inside it rather than resizing the frame. */
const BODY_ROWS = 14;
const MIN_WIDTH = 56;

interface ModelDraft {
	fields: Partial<ModelsJsonModel>;
}

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
		default:
			return item.kind;
	}
}

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
	private draft: ModelDraft | undefined;
	private fetchStatus: string | undefined;
	private disposed = false;
	private renaming = false;
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
		this.host = this.createHost();
		this.rebuildLeftItems();
		this.resetRightStack();
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
		if (kb.matches(data, "app.provider.switchPaneRight") || kb.matches(data, "tui.select.confirm")) {
			this.activateLeftItem();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.done("back");
	}

	/** Rebuild from the store view after a save merged external changes. */
	syncFromStore(): void {
		if (this.disposed || this.renaming) return;
		const selected = this.leftItems[this.leftIndex];
		const selectedKey = leftItemKey(selected);
		this.rebuildLeftItems();
		const nextIndex = this.leftItems.findIndex((item) => leftItemKey(item) === selectedKey);
		this.leftIndex = nextIndex >= 0 ? nextIndex : Math.min(this.leftIndex, this.selectableIndex(0));
		// If the selected model vanished externally, rebuild the right column.
		if (nextIndex < 0 && selected?.kind === "model") {
			this.resetRightStack();
		}
		this.refresh();
	}

	// ------------------------------------------------------------------
	// Left column
	// ------------------------------------------------------------------

	private rebuildLeftItems(): void {
		const items: LeftItem[] = [
			{ kind: "authentication" },
			{ kind: "apiType" },
			{ kind: "fetch" },
			{ kind: "separator" },
		];
		for (const model of this.options.store.getModels(this.options.providerId)) {
			items.push({ kind: "model", modelId: model.id });
		}
		if (this.draft) items.push({ kind: "draft" });
		items.push({ kind: "separator" }, { kind: "addModel" }, { kind: "deleteProvider" });
		this.leftItems = items;
	}

	private selectableIndex(start: number): number {
		const index = this.leftItems.findIndex((item, i) => i >= start && item.kind !== "separator");
		return index >= 0 ? index : 0;
	}

	private moveLeft(delta: number): void {
		const selectable = this.leftItems
			.map((item, index) => ({ item, index }))
			.filter((entry) => entry.item.kind !== "separator");
		if (selectable.length === 0) return;
		const position = selectable.findIndex((entry) => entry.index === this.leftIndex);
		const next = selectable[(position + delta + selectable.length) % selectable.length]!;
		if (next.index === this.leftIndex) return;
		this.leftIndex = next.index;
		// Moving the left selection replaces the right column (cancels fetch/edit state).
		this.resetRightStack();
		this.refresh();
	}

	private activateLeftItem(): void {
		const item = this.leftItems[this.leftIndex];
		if (!item) return;
		switch (item.kind) {
			case "authentication":
			case "apiType":
			case "model":
			case "draft":
				this.focusPane = "right";
				this.topPane()?.setFocused(this._focused);
				this.refresh();
				return;
			case "fetch": {
				this.focusPane = "right";
				const pane = this.topPane();
				if (pane instanceof FetchModelsPane) pane.start();
				pane?.setFocused(this._focused);
				this.refresh();
				return;
			}
			case "addModel": {
				if (!this.draft) {
					this.draft = { fields: {} };
					this.rebuildLeftItems();
				}
				const draftIndex = this.leftItems.findIndex((entry) => entry.kind === "draft");
				if (draftIndex >= 0) this.leftIndex = draftIndex;
				this.resetRightStack();
				this.focusPane = "right";
				const pane = this.topPane();
				pane?.setFocused(this._focused);
				if (pane instanceof ModelFieldsPane && !this.draft.fields.id) pane.startEditingId();
				this.refresh();
				return;
			}
			case "deleteProvider": {
				if (this.host.isCurrentProvider()) {
					this.host.notify(
						"The current model's provider cannot be deleted; switch models with /model first.",
						"error",
					);
					return;
				}
				const builtin = isBuiltinProviderId(this.options.providerId);
				this.host.confirm(
					`Delete provider "${this.options.providerId}" from models.json?` +
						(builtin ? " The built-in catalog remains and its models may reappear." : "") +
						" Stored credentials in auth.json are kept.",
					"Delete Provider",
					() => {
						this.options.store.removeProvider(this.options.providerId);
						this.options.refresher.touch(this.options.providerId);
						this.done("deleted");
					},
				);
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
			if (item.kind === "separator") {
				return theme.fg("borderMuted", `  ${"─".repeat(Math.max(1, width - 4))}`);
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
			const selectable: LeftItem[] = this.leftItems.filter((item) => item.kind !== "separator");
			const position = selectable.indexOf(this.leftItems[this.leftIndex]!);
			rows.push(theme.fg("dim", `  (${position + 1}/${selectable.length})`));
		}
		while (rows.length < BODY_ROWS) rows.push("");
		return rows;
	}

	private renderLeftItem(item: LeftItem, active: boolean, focused: boolean, width: number): string {
		const theme = this.theme;
		const store = this.options.store;
		// The selected row stays accent in both focus states: it is the section
		// the right column edits. Only an unfocused column dims its other rows.
		const marker = active ? theme.fg("accent", `${CURSOR} `) : "  ";
		const style = (text: string, dim = false) => theme.fg(active ? "accent" : dim || !focused ? "dim" : "text", text);
		let text: string;
		let note: string | undefined;
		switch (item.kind) {
			case "authentication":
				text = "Authentication";
				break;
			case "apiType":
				text = "API Type";
				break;
			case "fetch":
				text = "Fetch Models";
				note = this.fetchStatus;
				break;
			case "model": {
				const model = store.getModel(this.options.providerId, item.modelId);
				text = model ? modelDisplayName(model) : item.modelId;
				break;
			}
			case "draft": {
				text = this.draft?.fields.name ?? this.draft?.fields.id ?? "New Model";
				note = "· draft";
				break;
			}
			case "addModel":
				text = "+ Add Model";
				break;
			case "deleteProvider":
				text = "Delete Provider";
				break;
			default:
				text = "";
		}
		const dim = item.kind === "draft" && !this.draft?.fields.name && !this.draft?.fields.id;
		// Long model names keep head and tail (the distinctive parts) instead of a hard cut.
		if (item.kind === "model" || item.kind === "draft") {
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
				return new AuthPane(this.host, this.options.registry);
			case "apiType":
				return new ApiTypePane(this.host);
			case "fetch":
				return new FetchModelsPane(this.host);
			case "model":
				return new ModelFieldsPane(this.host, this.persistedHandle(item.modelId));
			case "draft":
				return new ModelFieldsPane(this.host, this.draftHandle());
			case "addModel":
				return new InfoPane(this.host, [
					"Press Enter to create a model.",
					"A draft is kept in memory until its id is set; Esc on the draft discards it.",
				]);
			case "deleteProvider":
				return new InfoPane(this.host, ["Press Enter to delete this provider from models.json."]);
			default:
				return new InfoPane(this.host, []);
		}
	}

	private persistedHandle(modelId: string): ModelHandle {
		const store = this.options.store;
		const providerId = this.options.providerId;
		const ref = { id: modelId };
		let renamingSnapshot: ModelsJsonModel | undefined;
		return {
			isDraft: false,
			read: () => renamingSnapshot ?? store.getModel(providerId, ref.id) ?? { id: ref.id },
			setField: (path, value) => {
				store.setModelField(providerId, ref.id, path, value);
			},
			rename: async (newId) => {
				const oldId = ref.id;
				renamingSnapshot = store.getModel(providerId, oldId);
				this.renaming = true;
				try {
					const error = await store.renameModel(providerId, oldId, newId);
					if (error) return error;
					ref.id = newId;
					const selected = this.leftItems[this.leftIndex];
					if (selected?.kind === "model" && selected.modelId === oldId) selected.modelId = newId;
					this.options.refresher.touch(providerId);
					return undefined;
				} finally {
					renamingSnapshot = undefined;
					this.renaming = false;
					this.syncFromStore();
				}
			},
		};
	}

	private draftHandle(): ModelHandle {
		const draft = this.draft;
		if (!draft) throw new Error("No model draft");
		return {
			isDraft: true,
			rename: async () => "Commit the model draft before renaming it.",
			read: () => draft.fields,
			setField: (path, value) => {
				if (path.length === 1) {
					const key = path[0]! as keyof ModelsJsonModel;
					if (value === DELETE) delete draft.fields[key];
					else (draft.fields as Record<string, unknown>)[key] = value;
				} else {
					// Nested draft fields (thinkingLevelMap.medium, compat.x, cost.input…)
					const [head, ...rest] = path as [keyof ModelsJsonModel, ...string[]];
					const container: Record<string, unknown> = { ...((draft.fields[head] as object) ?? {}) } as Record<
						string,
						unknown
					>;
					let current = container;
					for (const segment of rest.slice(0, -1)) {
						const next = current[segment];
						if (typeof next === "object" && next !== null && !Array.isArray(next)) {
							current = next as Record<string, unknown>;
						} else {
							const created: Record<string, unknown> = {};
							current[segment] = created;
							current = created;
						}
					}
					const leaf = rest[rest.length - 1]!;
					if (value === DELETE) delete current[leaf];
					else current[leaf] = value;
					(draft.fields as Record<string, unknown>)[head] = container;
				}
				this.refresh();
			},
		};
	}

	// ------------------------------------------------------------------
	// EditorHost implementation
	// ------------------------------------------------------------------

	private createHost(): EditorHost {
		const store = this.options.store;
		const providerId = this.options.providerId;
		return {
			tui: this.tui,
			theme: this.theme,
			keybindings: this.keybindings,
			store,
			refresher: this.options.refresher,
			providerId,
			pushPane: (pane) => this.pushPane(pane),
			popPane: () => this.popPane(),
			mutate: (apply) => {
				const before = store.pendingCount;
				apply();
				if (
					store.pendingCount !== before &&
					(!store.isDraftProvider(providerId) || hasProviderSettings(store.getProvider(providerId)))
				) {
					this.options.refresher.touch(providerId);
				}
				this.refresh();
			},
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
			isCurrentProvider: () => this.options.currentModel?.provider === providerId,
			setFetchStatus: (status) => {
				this.fetchStatus = status;
				this.refresh();
			},
			runFetch: (signal) => fetchProviderModels(this.options, signal),
			importModels: async (models, signal) => {
				const error = await importProviderModels(this.options, models, signal);
				if (!this.disposed) this.syncFromStore();
				return error;
			},
			confirm: (message, actionLabel, action) =>
				this.pushPane(new ConfirmPane(this.host, message, actionLabel, action)),
			onModelRemoved: () => {
				this.rebuildLeftItems();
				// Land on the next row where the model was; walk back over separators.
				this.leftIndex = Math.min(this.leftIndex, this.leftItems.length - 1);
				while (this.leftIndex > 0 && this.leftItems[this.leftIndex]?.kind === "separator") this.leftIndex--;
				if (this.leftItems[this.leftIndex]?.kind === "separator") this.leftIndex = this.selectableIndex(0);
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
		const id = (draft.fields.id ?? "").trim();
		if (!id) return "Model id is required.";
		if (this.options.store.getModel(this.options.providerId, id)) return `Model "${id}" already exists.`;
		if (!this.host.effectiveApi(draft.fields)) return "Cannot resolve an api — set API Type first.";
		if (!this.host.effectiveBaseUrl(draft.fields)) return "Cannot resolve a baseUrl — set Authentication first.";
		const fields = { ...draft.fields };
		const model: ModelsJsonModel = { ...fields, id };
		this.draft = undefined;
		this.host.mutate(() => this.options.store.addModel(this.options.providerId, model));
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
		const leftWidth = this.computeLeftWidth(width);
		const rightWidth = width - leftWidth - 3;
		const separator = theme.fg("border", " │ ");

		const title = this.renderTitle(width);
		const crumb = this.renderBreadcrumb(rightWidth);
		const leftLines = this.renderLeft(leftWidth);
		const pane = this.topPane();
		const paneLines = pane ? windowLines(theme, pane.render(rightWidth), BODY_ROWS - 1, pane.scrollWindow?.()) : [];
		const rightLines = [crumb, ...paneLines];
		const body: string[] = [];
		for (let row = 0; row < BODY_ROWS; row++) {
			const left = padTo(truncateToWidth(leftLines[row] ?? "", leftWidth), leftWidth);
			const right = truncateToWidth(rightLines[row] ?? "", rightWidth);
			body.push(left + separator + right);
		}

		const footerLines = this.renderFooter(width);
		return [border, title, border, ...body, border, ...footerLines, border];
	}

	/** Content-driven left width: fits the longest visible label, clamped to 16–40 and 45% of the terminal. */
	private computeLeftWidth(width: number): number {
		let longest = 12;
		for (const item of this.leftItems) {
			if (item.kind === "separator") continue;
			let label = "";
			switch (item.kind) {
				case "authentication":
					label = "Authentication";
					break;
				case "apiType":
					label = "API Type";
					break;
				case "fetch":
					label = `Fetch Models${this.fetchStatus ?? ""}`;
					break;
				case "model": {
					const model = this.options.store.getModel(this.options.providerId, item.modelId);
					label = model ? modelDisplayName(model) : item.modelId;
					break;
				}
				case "draft":
					label = `${this.draft?.fields.name ?? this.draft?.fields.id ?? "New Model"} · draft`;
					break;
				case "addModel":
					label = "+ Add Model";
					break;
				case "deleteProvider":
					label = "Delete Provider";
					break;
			}
			longest = Math.max(longest, visibleWidth(label));
		}
		const fit = Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, longest + 2));
		return Math.min(fit, Math.max(LEFT_WIDTH_MIN, Math.floor(width * 0.45)));
	}

	private renderTitle(width: number): string {
		const theme = this.theme;
		let title = ` /provider · ${this.options.providerId}`;
		if (isBuiltinProviderId(this.options.providerId)) title += " · overlays built-in catalog";
		return truncateToWidth(theme.fg("accent", theme.bold(title)), width);
	}

	private renderBreadcrumb(width: number): string {
		const parts = [this.options.providerId];
		const item = this.leftItems[this.leftIndex];
		if (item?.kind === "model") {
			const model = this.options.store.getModel(this.options.providerId, item.modelId);
			if (model) parts.push(modelDisplayName(model));
		} else if (item?.kind === "draft") {
			parts.push(this.draft?.fields.name ?? this.draft?.fields.id ?? "New Model");
		}
		const crumb = this.topPane()?.crumb;
		if (crumb) parts.push(crumb);
		return truncateToWidth(this.theme.fg("muted", parts.join(" › ")), width);
	}

	private renderFooter(width: number): string[] {
		const hints =
			this.focusPane === "left"
				? [
						rawKeyHint("↑↓", "move"),
						keyHint("tui.select.confirm", "enter"),
						keyHint("app.provider.switchPaneRight", "focus right"),
						keyHint("tui.select.cancel", "back"),
					].join("  ")
				: (this.topPane()?.hints() ?? "");
		return [truncateToWidth(hints, width)];
	}
}

function modelDisplayName(model: ModelsJsonModel): string {
	return model.name ?? model.id;
}
