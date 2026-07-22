import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

import type { TodoState, TodoStatus } from "./schema.ts";
import { getTodoState } from "./state.ts";
import { hasVisibleOverlayItems, renderOverlayLines } from "./view.ts";

const WIDGET_KEY = "pi-config-todos";
const RECENT_COMPLETION_MS = 30_000;

export class TodoOverlay {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private knownStatuses = new Map<number, TodoStatus>();
	private completedAt = new Map<number, number>();
	private hiddenCompleted = new Set<number>();
	private completionHideTimer: ReturnType<typeof setTimeout> | undefined;
	/** Pure render cache: same width + visibility state → skip rebuild. */
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	setUI(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.dispose();
		this.ui = ui;
	}

	resetVisibility(): void {
		this.clearCompletionHideTimer();
		this.knownStatuses.clear();
		this.completedAt.clear();
		this.hiddenCompleted.clear();
		this.invalidateRenderCache();
	}

	update(): void {
		if (!this.ui) return;
		const state = getTodoState();
		this.syncVisibilityFromState(state);
		this.invalidateRenderCache();

		// Register/unregister based on state, never as a render side effect.
		if (!hasVisibleOverlayItems(state, this.hiddenCompleted)) {
			if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = undefined;
			return;
		}

		if (!this.registered) {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render(theme, width),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
							this.invalidateRenderCache();
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
			return;
		}
		this.tui?.requestRender();
	}

	/** Track new completions for a short confirmation window; hide historical ones. */
	private syncVisibilityFromState(state: TodoState): void {
		const now = Date.now();
		const nextStatuses = new Map<number, TodoStatus>();

		for (const item of state.items) {
			nextStatuses.set(item.id, item.status);
			const previousStatus = this.knownStatuses.get(item.id);
			if (item.status !== "completed") {
				this.completedAt.delete(item.id);
				this.hiddenCompleted.delete(item.id);
				continue;
			}

			if (previousStatus === undefined) {
				// A replayed/reloaded completion is old from this overlay's point of
				// view. Keep the live surface focused on current work.
				this.hiddenCompleted.add(item.id);
				this.completedAt.delete(item.id);
				continue;
			}
			if (previousStatus !== "completed") {
				this.completedAt.set(item.id, now);
				this.hiddenCompleted.delete(item.id);
			}
		}

		for (const id of this.knownStatuses.keys()) {
			if (nextStatuses.has(id)) continue;
			this.completedAt.delete(id);
			this.hiddenCompleted.delete(id);
		}
		this.knownStatuses = nextStatuses;

		for (const [id, completedAt] of this.completedAt) {
			if (now - completedAt < RECENT_COMPLETION_MS) continue;
			this.completedAt.delete(id);
			this.hiddenCompleted.add(id);
		}
		this.scheduleCompletionHide();
	}

	private scheduleCompletionHide(): void {
		this.clearCompletionHideTimer();
		let earliestExpiry = Infinity;
		for (const completedAt of this.completedAt.values()) {
			earliestExpiry = Math.min(earliestExpiry, completedAt + RECENT_COMPLETION_MS);
		}
		if (!Number.isFinite(earliestExpiry)) return;

		this.completionHideTimer = setTimeout(
			() => {
				this.completionHideTimer = undefined;
				this.update();
			},
			Math.max(10, earliestExpiry - Date.now()),
		);
	}

	private clearCompletionHideTimer(): void {
		if (this.completionHideTimer === undefined) return;
		clearTimeout(this.completionHideTimer);
		this.completionHideTimer = undefined;
	}

	private invalidateRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private render(theme: Theme, width: number): string[] {
		const normalizedWidth = Math.max(1, width);
		if (this.cachedLines !== undefined && this.cachedWidth === normalizedWidth) return this.cachedLines;

		const lines = renderOverlayLines(getTodoState(), theme, normalizedWidth, this.hiddenCompleted);
		this.cachedWidth = normalizedWidth;
		this.cachedLines = lines;
		return lines;
	}

	dispose(): void {
		this.ui?.setWidget(WIDGET_KEY, undefined);
		this.tui = undefined;
		this.registered = false;
		this.ui = undefined;
		this.resetVisibility();
	}
}
