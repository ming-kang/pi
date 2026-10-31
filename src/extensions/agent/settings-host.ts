import {
	type Component,
	Container,
	type Focusable,
	isFocusable,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

type AgentSettingsPage = Component & { dispose?(): void };

export type AgentSettingsPageFactory<T> = (
	tui: TUI,
	theme: Theme,
	keys: KeybindingsManager,
	done: (result: T) => void,
) => AgentSettingsPage;

/**
 * One dialog lifetime for every Agent settings page. Pages swap synchronously, so the editor never
 * shows between the panel and a picker, nor while a choice is saved.
 */
export class AgentSettingsHost extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private page: AgentSettingsPage | undefined;
	/** Cleared once the page answers, so input waits for the next page instead of reaching a stale one. */
	private accepting = false;
	private active = false;
	private disposed = false;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
	}

	get focused(): boolean {
		return this.active;
	}
	set focused(value: boolean) {
		this.active = value;
		if (this.page && isFocusable(this.page)) this.page.focused = value;
	}

	/** Show a page until it answers; it stays visible until the next page replaces it. */
	show<T>(create: AgentSettingsPageFactory<T>): Promise<T> {
		return new Promise((resolve) => {
			// A torn-down dialog never answers, like any other disposed custom UI.
			if (this.disposed) return;
			let answered = false;
			const page = create(this.tui, this.theme, this.keys, (result) => {
				if (answered || this.disposed) return;
				answered = true;
				this.accepting = false;
				resolve(result);
			});
			this.replacePage(page);
			this.accepting = true;
		});
	}

	handleInput(data: string): void {
		if (this.accepting) this.page?.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		return this.accepting ? super.handleMouse(event) : undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.accepting = false;
		this.disposePage();
		this.clear();
	}

	private replacePage(page: AgentSettingsPage): void {
		this.disposePage();
		this.page = page;
		this.clear();
		this.addChild(page);
		if (isFocusable(page)) page.focused = this.active;
		this.tui.requestRender();
	}

	private disposePage(): void {
		const previous = this.page;
		this.page = undefined;
		if (previous && isFocusable(previous)) previous.focused = false;
		previous?.dispose?.();
	}
}
