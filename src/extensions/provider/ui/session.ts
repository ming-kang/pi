/** Persistent TUI root with synchronous page changes and one owned lifetime. */

import { type Component, Container, type Focusable, isFocusable, type TUI } from "@earendil-works/pi-tui";

export type ProviderComponent = Component & { dispose?(): void };

export class ProviderTuiSession extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly controller = new AbortController();
	private screen: ProviderComponent | undefined;
	private active = false;

	constructor(tui: TUI) {
		super();
		this.tui = tui;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}
	get focused(): boolean {
		return this.active;
	}
	set focused(value: boolean) {
		this.active = value;
		if (this.screen && isFocusable(this.screen)) this.screen.focused = value;
	}

	setScreen(screen: ProviderComponent): void {
		if (this.signal.aborted) {
			screen.dispose?.();
			return;
		}
		this.disposeScreen();
		this.screen = screen;
		this.clear();
		this.addChild(screen);
		this.tui.setFocus(this);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!this.signal.aborted) this.screen?.handleInput?.(data);
	}

	dispose(): void {
		if (this.signal.aborted) return;
		this.controller.abort();
		this.disposeScreen();
		this.clear();
	}

	private disposeScreen(): void {
		const previous = this.screen;
		this.screen = undefined;
		if (previous && isFocusable(previous)) previous.focused = false;
		previous?.dispose?.();
	}
}
