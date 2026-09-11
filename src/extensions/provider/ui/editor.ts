/**
 * Two-pane provider editor.
 *
 * Left column: Authentication / API Type / Fetch Models, the provider's
 * models (name → id → "New Model" fallback, one draft at a time), then
 * + Add Model and Delete Provider. Right column hosts the selected item's
 * field pane and sub-pane stack; both columns keep their own selection and
 * scroll position. Typing on a value row overwrites, Enter tweaks or enters,
 * ←/→ switch panes, Esc cancels/pops/backs out.
 */

import type { AuthResult, ModelAuth } from "@earendil-works/pi-ai";
import { type Component, type Focusable, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { builtinDefaults, isBuiltinProviderId } from "../catalog.ts";
import { API_TYPES, formatError, maskApiKey, truncate } from "../constants.ts";
import { type ProbeModel, type ProbeResult, probeProviderModels } from "../probe.ts";
import type { RefreshCoordinator } from "../refresh.ts";
import { DELETE, type ModelsJsonStore, type SaveConflict } from "../store.ts";
import { FetchModelsPane } from "./fetch-models.ts";
import { ModelFieldsPane } from "./model-fields.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import {
	CURSOR,
	isPrintableInput,
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	truncateMiddle,
	ValueEditor,
} from "./value-row.ts";

export interface ProviderEditorOptions {
	store: ModelsJsonStore;
	refresher: RefreshCoordinator;
	providerId: string;
	/** Session model at /provider open time; protects it and its provider from delete/rename. */
	currentModel?: { provider: string; id: string };
	registry: ModelRegistry;
	runtime: ModelRuntime;
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
const LEFT_MAX_VISIBLE = 12;
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
		this.options.store.discardProviderDraft(this.options.providerId);
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

	/** Called by the flow when a save settles with conflicts. */
	showConflicts(conflicts: SaveConflict[]): void {
		if (this.disposed) return;
		this.pushPane(new ConflictPane(this.host, conflicts));
		this.options.notify(
			`${conflicts.length} field(s) changed on disk since this page opened — resolve the conflicts in the right column.`,
			"warning",
		);
	}

	/** Rebuild from the store view after a save merged external changes. */
	syncFromStore(): void {
		if (this.disposed) return;
		const selected = this.leftItems[this.leftIndex];
		const selectedKey = leftItemKey(selected);
		this.rebuildLeftItems();
		const nextIndex = this.leftItems.findIndex((item) => leftItemKey(item) === selectedKey);
		this.leftIndex = nextIndex >= 0 ? nextIndex : Math.min(this.leftIndex, this.selectableIndex(0));
		// If the selected model vanished externally, rebuild the right column.
		const item = this.leftItems[this.leftIndex];
		if (item && item.kind === "model" && !this.options.store.getModel(this.options.providerId, item.modelId)) {
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
		const lines: string[] = [];
		const start = Math.max(
			0,
			Math.min(
				this.leftIndex - Math.floor(LEFT_MAX_VISIBLE / 2),
				Math.max(0, this.leftItems.length - LEFT_MAX_VISIBLE),
			),
		);
		const end = Math.min(start + LEFT_MAX_VISIBLE, this.leftItems.length);
		for (let index = start; index < end; index++) {
			const item = this.leftItems[index]!;
			if (item.kind === "separator") {
				lines.push(theme.fg("borderMuted", `  ${"─".repeat(Math.max(1, width - 4))}`));
				continue;
			}
			const active = index === this.leftIndex;
			const line = this.renderLeftItem(item, active, focused, width);
			lines.push(line);
		}
		return lines;
	}

	private renderLeftItem(item: LeftItem, active: boolean, focused: boolean, width: number): string {
		const theme = this.theme;
		const store = this.options.store;
		const color = focused ? "accent" : "muted";
		const marker = active ? theme.fg(active ? color : "text", `${CURSOR} `) : "  ";
		const style = (text: string, dim = false) =>
			theme.fg(active && focused ? "accent" : dim ? "dim" : active ? color : "text", text);
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
					"One unfinished draft can exist at a time; it is kept in memory until its id is set.",
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
		return {
			isDraft: false,
			read: () => store.getModel(providerId, ref.id) ?? { id: ref.id },
			setField: (path, value) => {
				// Renames keep the handle valid by updating the ref after their op.
				if (path.length === 1 && path[0] === "id" && typeof value === "string") {
					store.renameModel(providerId, ref.id, value);
					ref.id = value;
				} else {
					store.setModelField(providerId, ref.id, path, value);
				}
				this.options.refresher.touch(providerId);
			},
		};
	}

	private draftHandle(): ModelHandle {
		const draft = this.draft;
		if (!draft) throw new Error("No model draft");
		return {
			isDraft: true,
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
				apply();
				this.options.refresher.touch(providerId);
				this.refresh();
			},
			refresh: () => this.refresh(),
			notify: (message, type) => this.options.notify(message, type),
			effectiveApi: (model) => {
				const provider = store.getProvider(providerId);
				return (
					model?.api ?? provider?.api ?? builtinDefaults(providerId, model?.id, model?.api ?? provider?.api).api
				);
			},
			effectiveBaseUrl: (model) => {
				const provider = store.getProvider(providerId);
				return (
					model?.baseUrl ??
					provider?.baseUrl ??
					builtinDefaults(providerId, model?.id, model?.api ?? provider?.api).baseUrl
				);
			},
			commitModelDraft: () => this.commitModelDraft(),
			isCurrentModel: (modelId) =>
				this.options.currentModel?.provider === providerId && this.options.currentModel.id === modelId,
			isCurrentProvider: () => this.options.currentModel?.provider === providerId,
			setFetchStatus: (status) => {
				this.fetchStatus = status;
				this.refresh();
			},
			runFetch: (signal) => this.runFetch(signal),
			importModels: (models) => this.importModels(models),
			confirm: (message, actionLabel, action) =>
				this.pushPane(new ConfirmPane(this.host, message, actionLabel, action)),
			onModelRemoved: () => {
				this.draft = undefined;
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

	private async runFetch(signal: AbortSignal): Promise<ProbeResult> {
		const providerId = this.options.providerId;
		const provider = this.options.store.getProvider(providerId);
		const baseUrl = provider?.baseUrl;
		if (!baseUrl) return { ok: false, error: "Set a baseUrl under Authentication first." };
		// Sync the just-saved connection config into the runtime before resolving auth.
		await this.options.store.flush();
		const sync = await this.options.refresher.refreshNow(providerId, signal);
		if (signal.aborted) return { ok: false, error: "Cancelled." };
		if (!sync.ok) {
			return { ok: false, error: `Saved, but the provider did not reload: ${sync.errors.join("; ")}` };
		}
		let auth: AuthResult | undefined;
		try {
			auth = await this.options.runtime.getAuth(providerId, { signal });
		} catch (error) {
			return { ok: false, error: `Failed to resolve credentials: ${formatError(error)}` };
		}
		if (!auth?.auth.apiKey && provider.apiKey) {
			// Configured but unresolved: never fall back to an anonymous request.
			return { ok: false, error: "An apiKey is configured but did not resolve; check its value." };
		}
		const authInfo: ModelAuth | undefined = auth?.auth;
		return probeProviderModels({
			baseUrl: authInfo?.baseUrl ?? baseUrl,
			auth: authInfo,
			api: this.host.effectiveApi({}),
			signal,
		});
	}

	private async importModels(models: readonly ProbeModel[]): Promise<string | undefined> {
		const providerId = this.options.providerId;
		if (!this.host.effectiveApi({}) || !this.host.effectiveBaseUrl({})) {
			return "Imported models cannot resolve api/baseUrl — set API Type and Authentication first.";
		}
		const existing = new Set(this.options.store.getModels(providerId).map((model) => model.id));
		const fresh = models.filter((model) => !existing.has(model.id));
		if (fresh.length === 0) {
			undefined;
			return;
		}
		this.options.store.batch(() => {
			for (const model of fresh) {
				this.options.store.addModel(providerId, model.name ? { id: model.id, name: model.name } : { id: model.id });
			}
		});
		this.options.refresher.touch(providerId);
		await this.options.store.flush();
		const outcome = await this.options.refresher.refreshNow(providerId);
		this.rebuildLeftItems();
		this.refresh();
		if (!outcome.ok) return `Imported ${fresh.length} model(s), but refresh failed: ${outcome.errors.join("; ")}`;
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
		const rightBody = this.topPane()?.render(rightWidth) ?? [];
		const rightLines = [crumb, ...rightBody];
		const height = Math.max(leftLines.length, rightLines.length);
		const body: string[] = [];
		for (let row = 0; row < height; row++) {
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
		const theme = this.theme;
		const lines: string[] = [];
		if (this.focusPane === "left") {
			lines.push(
				[
					rawKeyHint("↑↓", "move"),
					keyHint("tui.select.confirm", "enter"),
					keyHint("app.provider.switchPaneRight", "focus right"),
					keyHint("tui.select.cancel", "back"),
				].join("  "),
			);
		} else {
			lines.push(this.topPane()?.hints() ?? "");
		}
		if (!this.options.store.hasWritten) {
			lines.push(
				theme.fg(
					"dim",
					"Saving rewrites models.json as two-space JSON (comments are dropped); the first save creates models.json.bak.",
				),
			);
		}
		return lines.filter(Boolean).map((line) => truncateToWidth(line, width));
	}
}

// -------------------------------------------------------------------------
// Small editor-bound panes
// -------------------------------------------------------------------------

function modelDisplayName(model: ModelsJsonModel): string {
	return model.name ?? model.id;
}

/** Static dim text lines (e.g. action-row explanations). */
class InfoPane implements EditorPane {
	readonly crumb: string | undefined;
	private readonly lines: string[];
	private readonly host: EditorHost;
	constructor(host: EditorHost, lines: string[], crumb?: string) {
		this.host = host;

		this.lines = lines;
		this.crumb = crumb;
	}
	render(width: number): string[] {
		return this.lines.map((line) => renderInfoLine(this.host.theme, line, width));
	}
	handleInput(data: string): void {
		if (this.host.keybindings.matches(data, "tui.select.cancel")) this.host.popPane();
	}
	setFocused(): void {}
	hints(): string {
		return keyHint("tui.select.cancel", "back");
	}
}

/** baseUrl / apiKey rows with masking and credential-source hints. */
class AuthPane implements EditorPane {
	readonly crumb = "Authentication";
	private readonly rows = ["baseUrl", "apiKey"] as const;
	private index = 0;
	private editing: ValueEditor | undefined;
	private editingRow: (typeof this.rows)[number] | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly registry: ModelRegistry;
	constructor(host: EditorHost, registry: ModelRegistry) {
		this.host = host;
		this.registry = registry;
	}

	private provider(): ModelsJsonProvider | undefined {
		return this.host.store.getProvider(this.host.providerId);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const provider = this.provider();
		const lines: string[] = [];
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			if (row === "baseUrl") {
				const value = provider?.baseUrl;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "baseUrl",
						valueText: value ?? "unset",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "baseUrl" ? this.editing : undefined,
						width,
					}),
				);
			} else {
				const value = provider?.apiKey;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "apiKey",
						valueText: value ? maskApiKey(value) : "unset",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "apiKey" ? this.editing : undefined,
						width,
					}),
				);
			}
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		const status = this.registry.getProviderAuthStatus(this.host.providerId);
		if (status.configured && status.source === "stored") {
			lines.push(
				renderInfoLine(theme, "A stored credential (auth.json) takes precedence over the apiKey here.", width),
			);
		} else if (status.configured && status.source === "environment") {
			lines.push(
				renderInfoLine(
					theme,
					`An environment variable (${status.label ?? "env"}) currently provides the key.`,
					width,
				),
			);
		}
		lines.push(
			renderInfoLine(theme, "Values are stored raw; $VAR / !command references resolve at request time.", width),
		);
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.editing) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return; // stay while editing
			this.editing.handleInput(data);
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.rows.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % this.rows.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.beginEdit("tweak");
			return;
		}
		if (isPrintableInput(data)) {
			this.beginEdit("overwrite", data);
			return;
		}
	}

	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const row = this.rows[this.index]!;
		const current = row === "baseUrl" ? (this.provider()?.baseUrl ?? "") : (this.provider()?.apiKey ?? "");
		const editor = new ValueEditor(this.host.keybindings, {
			onCommit: (value) => this.commit(row, value),
			onCancel: () => {
				this.editing = undefined;
				this.editingRow = undefined;
				this.error = undefined;
				this.host.refresh();
			},
		});
		this.editing = editor;
		this.editingRow = row;
		editor.focused = this.focused;
		if (mode === "overwrite") editor.beginOverwrite(firstData);
		else editor.beginTweak(current);
		this.host.refresh();
	}

	private commit(row: "baseUrl" | "apiKey", raw: string): void {
		const value = raw.trim();
		if (row === "baseUrl" && value) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				this.error = "baseUrl must be a valid URL.";
				this.host.refresh();
				return;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				this.error = `Unsupported protocol: ${url.protocol}`;
				this.host.refresh();
				return;
			}
			if (url.username || url.password || url.hash) {
				this.error = "baseUrl must not contain credentials or a fragment.";
				this.host.refresh();
				return;
			}
		}
		if (row === "baseUrl" && !value) {
			// Removing baseUrl is only allowed while models still resolve an address.
			const builtin = builtinDefaults(this.host.providerId).baseUrl !== undefined;
			const modelsCovered = this.host.store
				.getModels(this.host.providerId)
				.every((model) => model.baseUrl !== undefined);
			if (!builtin && !modelsCovered && this.host.store.getModels(this.host.providerId).length > 0) {
				this.error = "baseUrl cannot be removed while models rely on it.";
				this.host.refresh();
				return;
			}
		}
		this.error = undefined;
		this.editing = undefined;
		this.editingRow = undefined;
		this.host.mutate(() =>
			this.host.store.setProviderField(this.host.providerId, [row], value === "" ? DELETE : value),
		);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editing) this.editing.focused = focused;
	}

	isEditing(): boolean {
		return this.editing !== undefined;
	}

	hints(): string {
		if (this.editing) {
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		}
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit"),
			keyHint("app.provider.switchPaneLeft", "focus left"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/** Single-select provider api list; current value marked with ●. */
class ApiTypePane implements EditorPane {
	readonly crumb = "API Type";
	private index = 0;
	private focused = false;

	private readonly host: EditorHost;
	constructor(host: EditorHost) {
		this.host = host;

		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const options = this.options();
		this.index = Math.max(
			0,
			options.findIndex((option) => option === (current ?? UNSET)),
		);
	}

	private options(): string[] {
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const base: string[] = [UNSET, ...API_TYPES];
		if (current && !(API_TYPES as readonly string[]).includes(current)) base.push(current);
		return base;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		return this.options().map((option, rowIndex) => {
			const active = rowIndex === this.index;
			const selected = option === UNSET ? current === undefined : current === option;
			const label = `${selected ? "●" : "○"} ${option === UNSET ? "unset (models must define api)" : option}`;
			return renderPlainLine(theme, label, { active, paneFocused: this.focused, dim: option === UNSET, width });
		});
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const options = this.options();
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? options.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % options.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const option = options[this.index]!;
			this.host.mutate(() =>
				this.host.store.setProviderField(this.host.providerId, ["api"], option === UNSET ? DELETE : option),
			);
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "select"),
			keyHint("app.provider.switchPaneLeft", "focus left"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

const UNSET = "(unset)";

/** Yes/No confirm for destructive actions, pushed into the right column. */
class ConfirmPane implements EditorPane {
	readonly crumb = "Confirm";
	private index = 1; // default to Cancel
	private focused = false;

	private readonly host: EditorHost;
	private readonly message: string;
	private readonly actionLabel: string;
	private readonly action: () => void;

	constructor(host: EditorHost, message: string, actionLabel: string, action: () => void) {
		this.host = host;
		this.message = message;
		this.actionLabel = actionLabel;
		this.action = action;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		return [
			truncateToWidth(theme.fg("warning", this.message), width),
			renderPlainLine(theme, this.actionLabel, { active: this.index === 0, paneFocused: this.focused, width }),
			renderPlainLine(theme, "Cancel", { active: this.index === 1, paneFocused: this.focused, width }),
		];
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.index = this.index === 0 ? 1 : 0;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.index === 0) this.action();
			else this.host.popPane();
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [keyHint("tui.select.confirm", "choose"), keyHint("tui.select.cancel", "cancel")].join("  ");
	}
}

/** Lists save conflicts; each resolves to "keep mine" (rebase + retry) or "use external" (drop the op). */
class ConflictPane implements EditorPane {
	readonly crumb = "Conflicts";
	private conflicts: SaveConflict[];
	private index = 0;
	private choice: number | undefined; // 0 = keep mine, 1 = use external
	private focused = false;

	private readonly host: EditorHost;
	constructor(host: EditorHost, conflicts: SaveConflict[]) {
		this.host = host;

		this.conflicts = conflicts;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [renderInfoLine(theme, "These fields changed on disk after this page opened:", width)];
		for (const [rowIndex, conflict] of this.conflicts.entries()) {
			const active = rowIndex === this.index && this.choice === undefined;
			lines.push(
				renderPlainLine(theme, conflict.location, {
					active,
					paneFocused: this.focused,
					note: `yours ${conflict.attempted} · external ${conflict.external}`,
					width,
				}),
			);
			if (rowIndex === this.index && this.choice !== undefined) {
				lines.push(
					renderPlainLine(theme, "Keep my value", {
						active: this.choice === 0,
						paneFocused: this.focused,
						width,
					}),
				);
				lines.push(
					renderPlainLine(theme, "Use external value", {
						active: this.choice === 1,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.choice !== undefined) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.choice = this.choice === 0 ? 1 : 0;
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.choice = undefined;
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const conflict = this.conflicts[this.index]!;
				const keep = this.choice === 0;
				this.choice = undefined;
				this.host.store.resolveConflict(
					conflict.op.seq,
					keep ? "keep" : "external",
					conflict.externalRaw,
					conflict.externalPresent,
				);
				this.conflicts = this.conflicts.filter((entry) => entry !== conflict);
				if (this.conflicts.length === 0) {
					this.host.popPane();
					return;
				}
				this.index = Math.min(this.index, this.conflicts.length - 1);
				this.host.refresh();
				return;
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.conflicts.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % this.conflicts.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.choice = 0;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [keyHint("tui.select.confirm", "resolve"), keyHint("tui.select.cancel", "later")].join("  ");
	}
}
