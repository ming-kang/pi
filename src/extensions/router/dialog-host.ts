/** Extension-owned dialog host that keeps every /router TUI page in one modal lifecycle. */

import { type Component, Container, type Focusable, isFocusable, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { ExtensionInputComponent } from "../../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../../modes/interactive/components/extension-selector.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export type RouterComponent = Component & { dispose?(): void };

export type RouterComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => RouterComponent | Promise<RouterComponent>;

interface RouterDialogBase {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
}

export interface RouterNativeDialogs extends RouterDialogBase {
	readonly kind: "native";
	select(title: string, options: string[]): Promise<string | undefined>;
}

export interface RouterTuiDialogs extends RouterDialogBase {
	readonly kind: "tui";
	show<T>(factory: RouterComponentFactory<T>): Promise<T>;
}

export type RouterDialogs = RouterNativeDialogs | RouterTuiDialogs;

export class RouterTuiSessionClosedError extends Error {
	constructor() {
		super("Router TUI session is closed.");
		this.name = "RouterTuiSessionClosedError";
	}
}

export function createNativeRouterDialogs(ctx: ExtensionCommandContext): RouterNativeDialogs {
	return {
		kind: "native",
		select: (title, options) => ctx.ui.select(title, options),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		confirm: (title, message) => ctx.ui.confirm(title, message),
	};
}

/**
 * Persistent root mounted by one ctx.ui.custom() call. Child dialogs resolve
 * without closing this root, so async flow continuations can replace them
 * without exposing the main editor between pages.
 */
export class RouterTuiSession extends Container implements Focusable, RouterTuiDialogs {
	readonly kind = "tui" as const;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onTransitionClose: () => void;
	private activeScreen: RouterComponent | undefined;
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

		const loading = new Container();
		loading.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		loading.addChild(new Spacer(1));
		loading.addChild(new Text(theme.fg("muted", "Loading router…"), 1, 0));
		loading.addChild(new Spacer(1));
		loading.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		this.activeScreen = loading;
		this.addChild(loading);
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

	show<T>(factory: RouterComponentFactory<T>): Promise<T> {
		this.clearTransitionTimer();
		if (this.disposed || this.closeRequested) return Promise.reject(new RouterTuiSessionClosedError());
		if (this.pendingReject) return Promise.reject(new Error("Router TUI session already has an active dialog."));
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
			let pending: RouterComponent | Promise<RouterComponent>;
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

	input(title: string, placeholder?: string): Promise<string | undefined> {
		return this.show<string | undefined>(
			(tui, _theme, _keybindings, done) =>
				new ExtensionInputComponent(title, placeholder, done, () => done(undefined), { tui }),
		);
	}

	async confirm(title: string, message: string): Promise<boolean> {
		const selected = await this.show<string | undefined>(
			(tui, _theme, _keybindings, done) =>
				new ExtensionSelectorComponent(title, ["Yes", "No"], done, () => done(undefined), {
					tui,
					subtitle: message,
				}),
		);
		return selected === "Yes";
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
		reject?.(new RouterTuiSessionClosedError());
	}

	private beginTransition(): void {
		this.clearTransitionTimer();
		this.transitionTimer = setTimeout(() => {
			this.transitionTimer = undefined;
			if (this.disposed || this.closeRequested || this.acceptsInput) return;
			const working = new Container();
			working.addChild(new DynamicBorder((text) => this.theme.fg("border", text)));
			working.addChild(new Spacer(1));
			const cancelKey = keyLabel("tui.select.cancel", { keybindings: this.keybindings });
			const closeHint = cancelKey ? `${cancelKey} closes /router` : "Close /router to continue";
			working.addChild(new Text(this.theme.fg("muted", `Working…  ${closeHint}`), 1, 0));
			working.addChild(new Spacer(1));
			working.addChild(new DynamicBorder((text) => this.theme.fg("border", text)));
			this.disposeActiveScreen();
			this.clear();
			this.activeScreen = working;
			this.addChild(working);
			this.tui.requestRender();
		}, 150);
	}

	private clearTransitionTimer(): void {
		if (this.transitionTimer === undefined) return;
		clearTimeout(this.transitionTimer);
		this.transitionTimer = undefined;
	}

	private setActiveScreen(component: RouterComponent): void {
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

	private disposeScreen(screen: RouterComponent): void {
		const dispose = screen.dispose;
		if (isFocusable(screen)) screen.focused = false;
		try {
			dispose?.call(screen);
		} catch {
			// A child cleanup failure must not strand the outer custom lifecycle.
		}
	}
}
