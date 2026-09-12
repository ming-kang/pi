/** Pane contract for the /provider two-pane editor's right column. */

import type { TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ProbeModel, ProbeResult } from "../probe.ts";
import type { RefreshCoordinator } from "../refresh.ts";
import type { ModelsJsonStore } from "../store.ts";

export interface EditorPane {
	/** Breadcrumb segment appended to the provider/model path, e.g. "cost". */
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

/** Read/write access to the model under edit, draft or persisted. */
export interface ModelHandle {
	readonly isDraft: boolean;
	/** Current values; drafts carry the unsubmitted partial object. */
	read(): Partial<ModelsJsonModel> & { id?: string };
	/** Drafts mutate memory; persisted models queue a store op and schedule a save. */
	setField(path: readonly string[], value: unknown): void;
	/** Renaming an identity waits for storage before the UI starts using the new id. */
	rename(newId: string): Promise<string | undefined>;
}

export interface EditorHost {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly store: ModelsJsonStore;
	readonly refresher: RefreshCoordinator;
	readonly providerId: string;
	pushPane(pane: EditorPane): void;
	popPane(): void;
	/** Queue a mutation op, mark the provider touched, and repaint. */
	mutate(apply: () => void): void;
	refresh(): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
	/** Effective api/baseUrl after provider-level and builtin-overlay fallbacks. */
	effectiveApi(model?: Partial<ModelsJsonModel>): string | undefined;
	effectiveBaseUrl(model?: Partial<ModelsJsonModel>): string | undefined;
	/** Commit the pending model draft (id validation + addModel op); returns an error or undefined. */
	commitModelDraft(): string | undefined;
	/** Drop the in-memory model draft; the left column returns to + Add Model. */
	discardModelDraft(): void;
	/** Current session model protection (§4.3): no delete/rename of the active model or its provider. */
	isCurrentModel(modelId: string): boolean;
	isCurrentProvider(): boolean;
	/** Last Fetch Models outcome shown next to the left-column action row. */
	setFetchStatus(status: string | undefined): void;
	/** Refresh the provider, resolve auth canonically, and GET {baseUrl}/models. */
	runFetch(signal: AbortSignal): Promise<ProbeResult>;
	/** Validate + batch-add imported models, save once, refresh; returns an error or undefined. */
	importModels(models: readonly ProbeModel[], signal: AbortSignal): Promise<string | undefined>;
	/** Push an in-editor Yes/No confirm into the right column. */
	confirm(message: string, actionLabel: string, action: () => void): void;
	/** A model was just removed: rebuild the left column and reset the right stack. */
	onModelRemoved(modelId: string): void;
}
