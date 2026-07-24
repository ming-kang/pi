import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export interface PickerItem<T> {
	value: T;
	label: string;
	detail?: string;
	current?: boolean;
}

const MAX_VISIBLE = 10;

/**
 * Searchable selector matching the native /model experience: type to
 * fuzzy-filter, arrows wrap around the list, enter confirms, escape
 * cancels (resolves undefined). Mounted via ctx.ui.custom().
 */
export class SearchPickerComponent<T> extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly items: PickerItem<T>[];
	private readonly onDone: (value: T | undefined) => void;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private filtered: PickerItem<T>[];
	private selectedIndex = 0;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(theme: Theme, title: string, items: PickerItem<T>[], onDone: (value: T | undefined) => void) {
		super();
		this.theme = theme;
		this.items = items;
		this.onDone = onDone;
		this.filtered = items;
		const currentIndex = items.findIndex((item) => item.current);
		if (currentIndex >= 0) this.selectedIndex = currentIndex;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.confirm();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${theme.fg("muted", "↑↓")} ${theme.fg("dim", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	private filter(query: string): void {
		this.filtered = query
			? fuzzyFilter(this.items, query, (item) => `${item.label} ${item.detail ?? ""}`)
			: this.items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private confirm(): void {
		const selected = this.filtered[this.selectedIndex];
		if (selected) this.onDone(selected.value);
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filtered.length);
		for (let index = startIndex; index < endIndex; index++) {
			const item = this.filtered[index];
			if (!item) continue;
			const isSelected = index === this.selectedIndex;
			const marker = item.current ? this.theme.fg("success", " ✓") : "";
			const line = isSelected
				? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", item.label)}${marker}`
				: `  ${item.label}${marker}`;
			this.listContainer.addChild(new Text(line, 0, 0));
		}
		if (startIndex > 0 || endIndex < this.filtered.length) {
			this.listContainer.addChild(
				new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
			);
		}
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matches"), 0, 0));
			return;
		}
		const detail = this.filtered[this.selectedIndex]?.detail;
		if (detail) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  ${detail}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onDone(undefined);
		} else {
			this.searchInput.handleInput(keyData);
			this.filter(this.searchInput.getValue());
		}
	}
}
