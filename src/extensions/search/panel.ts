/**
 * The `/search` panel: one framed view whose screens replace each other in place — the account
 * menu, browser sign-in, token paste, sign-out confirmation, and a working state between them.
 */
import {
	type Component,
	Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { AuthUrlComponent } from "../../modes/interactive/components/auth-url.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

export interface AccountState {
	/** Where the credential comes from, or undefined when signed out. */
	source?: "saved" | "env";
	/** Where a saved credential lives, or the environment variable that supplies one. */
	location: string;
}

export interface PanelActions {
	state(): AccountState;
	/** A sign-in URL and a function that turns the pasted code or token into a verified, saved sign-in. */
	startSignIn(): { url: string; complete(input: string): Promise<void> };
	/** Verify and save a pasted token. */
	saveToken(input: string): Promise<void>;
	signOut(): void;
}

type Notice = { kind: "success" | "error"; text: string };

export class SearchPanel implements Component, Focusable {
	private content = new Container();
	private inputHandler: ((data: string) => void) | undefined;
	private input: Input | undefined;
	private notice: Notice | undefined;
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly actions: PanelActions;
	private readonly close: () => void;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, actions: PanelActions, close: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.actions = actions;
		this.close = close;
		this.showMenu();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	private show(
		title: string,
		body: Component[],
		hints: string[],
		handler?: (data: string) => void,
		input?: Input,
	): void {
		const accent = (text: string) => this.theme.fg("accent", text);
		const frame = new Container();
		frame.addChild(new DynamicBorder(accent));
		frame.addChild(new Text(accent(this.theme.bold(title)), 1, 0));
		for (const child of body) frame.addChild(child);
		frame.addChild(new Spacer(1));
		frame.addChild(new Text(hints.join(this.theme.fg("dim", " • ")), 1, 0));
		frame.addChild(new DynamicBorder(accent));
		if (this.input) this.input.focused = false;
		this.content = frame;
		this.inputHandler = handler;
		this.input = input;
		if (input) input.focused = this._focused;
		this.tui.requestRender();
	}

	private muted(text: string): Text {
		return new Text(this.theme.fg("muted", text), 1, 0);
	}

	private showMenu(): void {
		const { source, location } = this.actions.state();
		const status = source
			? `${this.theme.fg("success", "●")} Signed in${source === "env" ? " from the environment" : ""} ${this.theme.fg("dim", `· ${location}`)}`
			: `${this.theme.fg("dim", "○")} Not signed in ${this.theme.fg("dim", "· code_search and web_search are off")}`;
		const body: Component[] = [new Text(status, 1, 0)];
		if (this.notice) {
			body.push(new Text(this.theme.fg(this.notice.kind, this.notice.text), 1, 0));
			this.notice = undefined;
		}
		body.push(new Spacer(1));

		const items: SelectItem[] = [
			{
				value: "browser",
				label: source ? "Switch account" : "Sign in with browser",
				description: "Authorize on devin.ai, then paste the code",
			},
			{ value: "paste", label: "Paste a token", description: "Use an existing Devin session token" },
		];
		if (source === "saved")
			items.push({ value: "signout", label: "Sign out", description: "Forget the saved token" });
		const list = new SelectList(items, items.length, getSelectListTheme());
		list.onSelect = (item) => {
			if (item.value === "browser") this.showBrowserSignIn();
			else if (item.value === "paste") this.showPaste();
			else this.showSignOut();
		};
		list.onCancel = () => this.close();
		body.push(list);
		this.show(
			"Devin Search",
			body,
			[keyHint("tui.select.confirm", "select"), keyHint("tui.select.cancel", "close")],
			(data) => list.handleInput(data),
		);
	}

	/** A screen with one text field; Enter submits a non-empty value, Esc returns to the menu. */
	private showInputScreen(
		title: string,
		intro: Component[],
		label: string,
		submit: (value: string) => Promise<void>,
		extraKey?: (data: string) => boolean,
	): void {
		const input = new Input();
		this.show(
			title,
			[...intro, new Spacer(1), this.muted(label), input],
			[keyHint("tui.select.confirm", "submit"), keyHint("tui.select.cancel", "back")],
			(data) => {
				if (this.keybindings.matches(data, "tui.select.confirm")) {
					const value = input.getValue().trim();
					if (value) void this.run(() => submit(value));
				} else if (this.keybindings.matches(data, "tui.select.cancel")) {
					this.showMenu();
				} else if (!extraKey?.(data)) {
					input.handleInput(data);
				}
			},
			input,
		);
	}

	private showBrowserSignIn(): void {
		const attempt = this.actions.startSignIn();
		const link = new AuthUrlComponent(this.tui, attempt.url);
		this.showInputScreen(
			"Sign in to Devin",
			[new Spacer(1), this.muted("Approve access in your browser. If it did not open, visit:"), link],
			"Paste the code Devin shows:",
			(value) => attempt.complete(value),
			(data) => {
				if (!this.keybindings.matches(data, "app.message.copy")) return false;
				void link.copy();
				return true;
			},
		);
	}

	private showPaste(): void {
		this.showInputScreen("Paste a token", [], "Devin session token:", (value) => this.actions.saveToken(value));
	}

	private showSignOut(): void {
		const { location } = this.actions.state();
		const items: SelectItem[] = [
			{ value: "signout", label: "Sign out", description: `Remove the token from ${location}` },
			{ value: "back", label: "Cancel" },
		];
		const list = new SelectList(items, items.length, getSelectListTheme());
		list.onSelect = (item) => {
			if (item.value === "signout") {
				this.actions.signOut();
				this.notice = { kind: "success", text: "Signed out." };
			}
			this.showMenu();
		};
		list.onCancel = () => this.showMenu();
		this.show(
			"Sign out of Devin?",
			[new Spacer(1), list],
			[keyHint("tui.select.confirm", "select"), keyHint("tui.select.cancel", "back")],
			(data) => list.handleInput(data),
		);
	}

	/** Show a working state while `task` runs, then return to the menu with its outcome. */
	private async run(task: () => Promise<void>): Promise<void> {
		this.show(
			"Devin Search",
			[new Spacer(1), this.muted("Verifying with Devin…")],
			[this.theme.fg("dim", "please wait")],
		);
		try {
			await task();
			this.notice = { kind: "success", text: "Signed in — code_search and web_search are on." };
		} catch (error) {
			this.notice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
		}
		this.showMenu();
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}
