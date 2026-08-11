/**
 * todo/widget.ts — above-editor widget for the v2 todo extension.
 *
 * The widget mirrors the closure store through a `getState` callback: it
 * registers only while at least one open task exists, renders exactly one
 * (or zero) line, and keeps no timers, completion tracking, hidden sets,
 * caches, or completion-visibility state. Rendering is uncached and styled
 * at render time; `invalidate` never touches registration state.
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { TodoState } from "./schema.ts";
import { hasOpenTodos, renderWidgetLine } from "./view.ts";

const WIDGET_KEY = "todos";

export class TodoWidget {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private readonly getState: () => TodoState;

	constructor(getState: () => TodoState) {
		this.getState = getState;
	}

	setUI(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.dispose();
		this.ui = ui;
	}

	/** Re-evaluate registration against the current state and redraw. */
	update(): void {
		if (!this.ui) return;
		if (!hasOpenTodos(this.getState())) {
			this.unregister();
			return;
		}
		if (this.registered) {
			this.tui?.requestRender();
			return;
		}
		this.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => renderWidgetLine(this.getState(), theme, width),
					invalidate: () => {
						// Rendering is uncached and styled at render time, so there is
						// nothing to clear; registration state is intentionally untouched.
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.registered = true;
	}

	private unregister(): void {
		if (!this.registered) return;
		this.ui?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
	}

	dispose(): void {
		this.unregister();
		this.ui = undefined;
	}
}
