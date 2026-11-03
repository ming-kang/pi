/**
 * Built-in models pane: a searchable list of a built-in provider's catalog.
 * Enter opens the model's override page; overridden models are marked so the
 * customized few stand out among hundreds of catalog entries.
 */

import "../keybindings.ts";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinModelIds } from "../catalog.ts";
import { moveSelection } from "./controls.ts";
import type { BuiltinModelsHost, EditorPane } from "./pane.ts";
import {
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	type ScrollWindowInfo,
	truncateMiddle,
	ValueEditor,
} from "./value-row.ts";

export class BuiltinModelsPane implements EditorPane {
	private readonly host: BuiltinModelsHost;
	private readonly ids: readonly string[];
	private readonly search: ValueEditor;
	private index = 0;
	private focused = false;

	constructor(host: BuiltinModelsHost) {
		this.host = host;
		this.ids = builtinModelIds(host.providerId);
		this.search = new ValueEditor({ onCommit: () => this.open(), onCancel: () => this.host.popPane() });
	}

	private filtered(): readonly string[] {
		const query = this.search.value.trim();
		return query ? fuzzyFilter([...this.ids], query, (id) => id) : this.ids;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const overridden = this.host.store.getProvider(this.host.providerId)?.modelOverrides ?? {};
		const entries = this.filtered();
		this.index = Math.min(this.index, Math.max(0, entries.length - 1));
		const lines = [
			renderKeyValueLine(theme, {
				keyLabel: "Search",
				active: false,
				paneFocused: this.focused,
				editing: this.search,
				width,
			}),
		];
		for (const [row, id] of entries.entries()) {
			const note = Object.hasOwn(overridden, id) ? " · overridden" : "";
			lines.push(
				renderPlainLine(theme, truncateMiddle(id, Math.max(8, width - 2 - note.length)) + note, {
					active: row === this.index,
					paneFocused: this.focused,
					width,
				}),
			);
		}
		if (entries.length === 0) lines.push(renderInfoLine(theme, "No built-in models match.", width));
		lines.push(renderInfoLine(theme, `${entries.length} of ${this.ids.length} built-in models`, width));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		return { top: 1, bottom: this.filtered().length === 0 ? 2 : 1, cursor: 1 + this.index };
	}

	handleInput(data: string): void {
		const next = moveSelection(this.host.keybindings, data, this.index, this.filtered().length);
		if (next !== undefined) this.index = next;
		else {
			const previous = this.search.value;
			this.search.handleInput(data); // Enter and Esc arrive through the editor callbacks
			if (this.search.value !== previous) this.index = 0;
		}
		this.host.refresh();
	}

	private open(): void {
		const id = this.filtered()[this.index];
		if (id) this.host.openOverride(id);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.search.focused = focused;
	}

	hints(): string {
		return [
			rawKeyHint("type", "search"),
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "open"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
