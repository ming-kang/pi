/** Confirmation and information panes owned by the provider editor. */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { CURSOR, renderInfoLine, renderPlainLine } from "./value-row.ts";

/** Static dim text lines (e.g. action-row explanations); optionally Enter-activatable. */
export class InfoPane implements EditorPane {
	private readonly lines: string[];
	private readonly onConfirm: (() => void) | undefined;
	private focused = false;
	private readonly host: EditorHost;
	constructor(host: EditorHost, lines: string[], onConfirm?: () => void) {
		this.host = host;

		this.lines = lines;
		this.onConfirm = onConfirm;
	}
	render(width: number): string[] {
		// A confirmable InfoPane carries the pane's single focus marker; pure
		// guard text offers no action, so it stays an unmarked hint.
		if (this.focused && this.onConfirm) {
			return this.lines.map((line, index) => {
				if (index > 0) return renderInfoLine(this.host.theme, line, width);
				return truncateToWidth(
					this.host.theme.fg("accent", `${CURSOR} `) + this.host.theme.fg("text", line),
					width,
				);
			});
		}
		return this.lines.map((line) => renderInfoLine(this.host.theme, line, width));
	}
	handleInput(data: string): void {
		if (this.host.keybindings.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		// A focused InfoPane stands in for its left-column action row.
		if (this.onConfirm && this.host.keybindings.matches(data, "tui.select.confirm")) this.onConfirm();
	}
	setFocused(focused: boolean): void {
		this.focused = focused;
	}
	hints(): string {
		const hints: string[] = [];
		if (this.onConfirm) hints.push(keyHint("tui.select.confirm", "proceed"));
		hints.push(keyHint("tui.select.cancel", "back"));
		return hints.join("  ");
	}
}

/** Yes/No confirm for destructive actions, pushed into the right column. */
export class ConfirmPane implements EditorPane {
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
