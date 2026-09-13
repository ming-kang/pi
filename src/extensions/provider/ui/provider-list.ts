/** Searchable provider list and new-provider id entry. */

import { type Component, type Focusable, fuzzyFilter, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { plural } from "../constants.ts";
import type { ModelsJsonStore } from "../store.ts";
import { renderInfoLine, renderKeyValueLine, renderPlainLine, ValueEditor, windowLines } from "./value-row.ts";

/** Fixed list-area height: the screen frame matches the provider editor's. */
const LIST_ROWS = 12;
export type ProviderListResult = { kind: "open"; providerId: string } | { kind: "close" };

export class ProviderListScreen implements Component, Focusable {
	private readonly input: ValueEditor;
	private readonly store: ModelsJsonStore;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: ProviderListResult) => void;
	private mode: "list" | "newProvider" = "list";
	private query = "";
	private index = 0;
	private error: string | undefined;
	private active = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: ProviderListResult) => void,
		store: ModelsJsonStore,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.store = store;
		this.input = new ValueEditor({ onCommit: () => this.confirm(), onCancel: () => this.cancel() });
	}

	get focused(): boolean {
		return this.active;
	}
	set focused(value: boolean) {
		this.active = value;
		this.input.focused = value;
	}
	invalidate(): void {}

	private filtered(): string[] {
		const ids = this.store.getProviderIds();
		return this.query.trim() ? fuzzyFilter(ids, this.query, (id) => id) : ids;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = new DynamicBorder((text) => theme.fg("border", text)).render(width)[0] ?? "";
		const lines = [
			border,
			truncateToWidth(theme.fg("accent", theme.bold(" /provider — models.json providers")), width),
			border,
			renderKeyValueLine(theme, {
				keyLabel: this.mode === "list" ? "Search" : "Provider id",
				active: false,
				paneFocused: this.active,
				editing: this.input,
				width,
			}),
			"",
		];
		// The list area is a fixed window: overlong lists scroll with a (n/N)
		// indicator (the /model selector convention) instead of resizing.
		const area: string[] = [];
		if (this.mode === "list") {
			const entries = this.filtered();
			const total = entries.length + 1;
			this.index = Math.min(this.index, total - 1);
			const rows: string[] = [];
			for (let row = 0; row < total; row++) {
				const id = entries[row - 1];
				const provider = id === undefined ? undefined : this.store.getProvider(id);
				const note =
					id === undefined
						? undefined
						: provider
							? [
									`${String(provider.models?.length ?? 0)} ${plural(provider.models?.length ?? 0, "model")}`,
									provider.api,
								]
									.filter(Boolean)
									.join(" · ")
							: "pending deletion";
				rows.push(
					renderPlainLine(theme, row === 0 ? "+ Add Provider" : id!, {
						active: row === this.index,
						paneFocused: this.active,
						note,
						width,
					}),
				);
			}
			if (entries.length === 0)
				rows.push(renderInfoLine(theme, this.query ? "No matching providers." : "No providers yet.", width));
			area.push(...windowLines(theme, rows, LIST_ROWS, { cursor: this.index }));
		} else if (this.error) {
			area.push(truncateToWidth(theme.fg("error", this.error), width));
		}
		while (area.length < LIST_ROWS) area.push("");
		const hints =
			this.mode === "newProvider"
				? [keyHint("tui.input.submit", "create"), keyHint("tui.select.cancel", "cancel")]
				: [
						rawKeyHint("type", "filter"),
						rawKeyHint("↑↓", "move"),
						keyHint("tui.select.confirm", "open"),
						keyHint("tui.select.cancel", "close"),
					];
		return [...lines, ...area, border, truncateToWidth(hints.join("  "), width), border];
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (this.mode === "list") {
			const total = this.filtered().length + 1;
			if (kb.matches(data, "tui.select.up")) this.index = (this.index + total - 1) % total;
			else if (kb.matches(data, "tui.select.down")) this.index = (this.index + 1) % total;
			else if (kb.matches(data, "tui.select.confirm")) {
				this.confirm();
				return;
			} else {
				const previous = this.query;
				this.input.handleInput(data);
				this.query = this.input.value;
				if (this.query !== previous) this.index = this.query && this.filtered().length > 0 ? 1 : 0;
			}
		} else this.input.handleInput(data);
		this.tui.requestRender();
	}

	private confirm(): void {
		if (this.mode === "newProvider") {
			const id = this.input.value.trim();
			if (!id) this.error = "Provider id must be non-empty.";
			else if (this.store.getProviderIds().includes(id)) this.error = "This provider id already exists.";
			else {
				this.store.ensureProviderView(id);
				this.done({ kind: "open", providerId: id });
				return;
			}
		} else if (this.index === 0) {
			this.mode = "newProvider";
			this.error = undefined;
			// A fruitless search becomes the new id — type once, create once.
			this.input.reset(this.query);
		} else {
			const id = this.filtered()[this.index - 1];
			if (id) this.done({ kind: "open", providerId: id });
		}
		this.tui.requestRender();
	}

	private cancel(): void {
		if (this.mode === "list") {
			this.done({ kind: "close" });
			return;
		}
		this.mode = "list";
		this.error = undefined;
		this.input.reset(this.query);
		this.tui.requestRender();
	}
}
