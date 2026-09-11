/**
 * Persistent modal root for /provider. Every page (provider list, two-pane
 * editor) lives in one ctx.ui.custom() lifecycle; page swaps never expose the
 * main editor. Adapted from the retired router extension's dialog host.
 */

import { type Component, Container, type Focusable, isFocusable, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

export type ProviderComponent = Component & { dispose?(): void };

export type ProviderComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => ProviderComponent | Promise<ProviderComponent>;

export class ProviderSessionClosedError extends Error {
	constructor() {
		super("Provider TUI session is closed.");
		this.name = "ProviderSessionClosedError";
	}
}

function loadingScreen(theme: Theme, message: string, keybindings: KeybindingsManager): ProviderComponent {
	const container = new Container();
	container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
	container.addChild(new Spacer(1));
	const cancelKey = keyLabel("tui.select.cancel", { keybindings });
	container.addChild(
		new Text(theme.fg("muted", cancelKey ? `${message}  ${cancelKey} closes /provider` : message), 1, 0),
	);
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
	return container;
}

export class ProviderTuiSession extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onTransitionClose: () => void;
	private activeScreen: ProviderComponent | undefined;
	private pendingReject: ((error: Error) => void) | undefined;
	private transitionTimer: ReturnType<typeof setTimeout> | undefined;
	private acceptsInput = false;
	private closeRequested = false;
	private disposed = false;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, onTransitionClose: () => void) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onTransitionClose = onTransitionClose;
		this.activeScreen = loadingScreen(theme, "Loading /provider…", keybindings);
		this.addChild(this.activeScreen);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.activeScreen && isFocusable(this.activeScreen)) {
			this.activeScreen.focused = value && this.acceptsInput;
		}
	}

	show<T>(factory: ProviderComponentFactory<T>): Promise<T> {
		this.clearTransitionTimer();
		if (this.disposed || this.closeRequested) return Promise.reject(new ProviderSessionClosedError());
		if (this.pendingReject) return Promise.reject(new Error("/provider already has an active page."));
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const fail = (error: unknown) => {
				if (settled || this.disposed) return;
				settled = true;
				this.acceptsInput = false;
				if (this.pendingReject === reject) this.pendingReject = undefined;
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			const done = (result: T) => {
				if (settled || this.disposed) return;
				settled = true;
				this.acceptsInput = false;
				if (this.activeScreen && isFocusable(this.activeScreen)) this.activeScreen.focused = false;
				if (this.pendingReject === reject) this.pendingReject = undefined;
				this.tui.setFocus(this);
				this.beginTransition();
				resolve(result);
			};
			this.pendingReject = reject;
			let pending: ProviderComponent | Promise<ProviderComponent>;
			try {
				pending = factory(this.tui, this.theme, this.keybindings, done);
			} catch (error) {
				fail(error);
				return;
			}
			void Promise.resolve(pending).then((component) => {
				if (settled || this.disposed) {
					this.disposeScreen(component);
					return;
				}
				try {
					this.setActiveScreen(component);
				} catch (error) {
					this.disposeScreen(component);
					fail(error);
				}
			}, fail);
		});
	}

	handleInput(data: string): void {
		if (this.acceptsInput) {
			this.activeScreen?.handleInput?.(data);
			return;
		}
		if (this.closeRequested || !this.keybindings.matches(data, "tui.select.cancel")) return;
		this.closeRequested = true;
		this.onTransitionClose();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.acceptsInput = false;
		this.clearTransitionTimer();
		const reject = this.pendingReject;
		this.pendingReject = undefined;
		this.disposeActiveScreen();
		this.clear();
		reject?.(new ProviderSessionClosedError());
	}

	private beginTransition(): void {
		this.clearTransitionTimer();
		this.transitionTimer = setTimeout(() => {
			this.transitionTimer = undefined;
			if (this.disposed || this.closeRequested || this.acceptsInput) return;
			this.disposeActiveScreen();
			this.clear();
			this.activeScreen = loadingScreen(this.theme, "Working…", this.keybindings);
			this.addChild(this.activeScreen);
			this.tui.requestRender();
		}, 150);
	}

	private clearTransitionTimer(): void {
		if (this.transitionTimer === undefined) return;
		clearTimeout(this.transitionTimer);
		this.transitionTimer = undefined;
	}

	private setActiveScreen(component: ProviderComponent): void {
		this.disposeActiveScreen();
		this.clear();
		this.activeScreen = component;
		this.addChild(component);
		this.acceptsInput = true;
		this.tui.setFocus(component);
		this.tui.requestRender();
	}

	private disposeActiveScreen(): void {
		const screen = this.activeScreen;
		this.activeScreen = undefined;
		if (screen) this.disposeScreen(screen);
	}

	private disposeScreen(screen: ProviderComponent): void {
		const dispose = screen.dispose;
		if (isFocusable(screen)) screen.focused = false;
		try {
			dispose?.call(screen);
		} catch {
			// A child cleanup failure must not strand the outer custom lifecycle.
		}
	}
}
