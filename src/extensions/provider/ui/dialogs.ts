/** Confirmation, conflict, and information panes owned by the provider editor. */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { SaveConflict } from "../store.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { renderInfoLine, renderPlainLine } from "./value-row.ts";

/** Static dim text lines (e.g. action-row explanations). */
export class InfoPane implements EditorPane {
	readonly crumb: string | undefined;
	private readonly lines: string[];
	private readonly host: EditorHost;
	constructor(host: EditorHost, lines: string[], crumb?: string) {
		this.host = host;

		this.lines = lines;
		this.crumb = crumb;
	}
	render(width: number): string[] {
		return this.lines.map((line) => renderInfoLine(this.host.theme, line, width));
	}
	handleInput(data: string): void {
		if (this.host.keybindings.matches(data, "tui.select.cancel")) this.host.popPane();
	}
	setFocused(): void {}
	hints(): string {
		return keyHint("tui.select.cancel", "back");
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

/** Lists save conflicts; each resolves to "keep mine" (rebase + retry) or "use external" (drop the op). */
export class ConflictPane implements EditorPane {
	readonly crumb = "Conflicts";
	private conflicts: SaveConflict[];
	private index = 0;
	private choice: number | undefined; // 0 = keep mine, 1 = use external
	private focused = false;

	private readonly host: EditorHost;
	constructor(host: EditorHost, conflicts: SaveConflict[]) {
		this.host = host;

		this.conflicts = conflicts;
	}

	update(conflicts: SaveConflict[]): void {
		const selected = this.conflicts[this.index]?.op.seq;
		this.conflicts = conflicts;
		this.index = Math.max(
			0,
			conflicts.findIndex((conflict) => conflict.op.seq === selected),
		);
		this.choice = undefined;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [renderInfoLine(theme, "These fields changed on disk after this page opened:", width)];
		for (const [rowIndex, conflict] of this.conflicts.entries()) {
			const active = rowIndex === this.index && this.choice === undefined;
			lines.push(
				renderPlainLine(theme, conflict.location, {
					active,
					paneFocused: this.focused,
					note: `yours ${conflict.attempted} · external ${conflict.external}`,
					width,
				}),
			);
			if (rowIndex === this.index && this.choice !== undefined) {
				lines.push(
					renderPlainLine(theme, "Keep my value", {
						active: this.choice === 0,
						paneFocused: this.focused,
						width,
					}),
				);
				lines.push(
					renderPlainLine(theme, "Use external value", {
						active: this.choice === 1,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.choice !== undefined) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.choice = this.choice === 0 ? 1 : 0;
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.choice = undefined;
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const conflict = this.conflicts[this.index]!;
				const keep = this.choice === 0;
				this.choice = undefined;
				this.host.store.resolveConflict(
					conflict.op.seq,
					keep ? "keep" : "external",
					conflict.externalRaw,
					conflict.externalPresent,
				);
				this.conflicts = this.conflicts.filter((entry) => entry !== conflict);
				if (this.conflicts.length === 0) {
					this.host.popPane();
					return;
				}
				this.index = Math.min(this.index, this.conflicts.length - 1);
				this.host.refresh();
				return;
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.conflicts.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % this.conflicts.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.choice = 0;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [keyHint("tui.select.confirm", "resolve"), keyHint("tui.select.cancel", "later")].join("  ");
	}
}
