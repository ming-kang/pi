/** Pane contract for the /provider two-pane editor's right column. */

import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ProviderEdits, ProviderView } from "../editing.ts";
import type { ProbeModel, ProbeResult } from "../probe.ts";

export type { ModelHandle } from "../editing.ts";

export interface EditorPane {
	/** Drill-down label shown at the top of the right column while this sub-pane is open, e.g. "cost". */
	readonly crumb?: string;
	/**
	 * Scroll position for the editor's fixed-height right column. `top` and
	 * `bottom` count pinned render() lines that never scroll (filter inputs,
	 * status/error lines); `cursor` is the render() line index the window
	 * keeps visible. Omitted: no scrolling, content is expected to fit.
	 */
	scrollWindow?(): { top?: number; bottom?: number; cursor?: number };
	/** Body lines for the right column. */
	render(width: number): string[];
	/** Input while the right column is focused. */
	handleInput(data: string): void;
	/** True while a text editor inside the pane owns ←/→ (cursor movement beats pane switching). */
	isEditing?(): boolean;
	/** Focus propagation for embedded Input components (IME cursor placement). */
	setFocused(focused: boolean): void;
	/** Contextual footer hint line. */
	hints(): string;
	dispose?(): void;
}

/** What every pane gets: rendering resources, right-column navigation, and user feedback. */
export interface PaneHost {
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	pushPane(pane: EditorPane): void;
	popPane(): void;
	refresh(): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
	/** Push an in-editor Yes/No confirm into the right column. */
	confirm(message: string, actionLabel: string, action: () => void): void;
}

/** A pane that reads or edits the provider being configured. */
export interface ProviderPaneHost extends PaneHost {
	readonly store: ProviderView;
	readonly edits: Pick<ProviderEdits, "setProviderField" | "removeModel" | "batch">;
	readonly providerId: string;
	/** Effective api/baseUrl after provider-level and builtin-overlay fallbacks. */
	effectiveApi(model?: Partial<ModelsJsonModel>): string | undefined;
	effectiveBaseUrl(model?: Partial<ModelsJsonModel>): string | undefined;
}

/** The model fields pane, which also changes the left column's model rows. */
export interface ModelFieldsHost extends ProviderPaneHost {
	/** Commit the pending model draft (id validation + addModel op); returns an error or undefined. */
	commitModelDraft(): string | undefined;
	/** Drop the in-memory model draft; the left column returns to + Add Model. */
	discardModelDraft(): void;
	/** Current session model protection (§4.3): no delete/rename of the active model. */
	isCurrentModel(modelId: string): boolean;
	/** A model was just removed: rebuild the left column and reset the right stack. */
	onModelRemoved(modelId: string): void;
}

/** The Fetch Models pane. */
export interface FetchModelsHost extends ProviderPaneHost {
	/** Last Fetch Models outcome shown next to the left-column action row. */
	setFetchStatus(status: string | undefined): void;
	/** Refresh the provider, resolve auth canonically, and GET {baseUrl}/models. */
	runFetch(signal: AbortSignal): Promise<ProbeResult>;
	/** Validate + batch-add imported models, save once, refresh; returns an error or undefined. */
	importModels(models: readonly ProbeModel[], signal: AbortSignal): Promise<string | undefined>;
}

/** Everything the editor screen provides. Each pane declares only the part it uses. */
export type EditorHost = ModelFieldsHost & FetchModelsHost;
