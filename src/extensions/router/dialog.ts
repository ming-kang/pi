/** Private TUI primitives for /router. */

import {
	Container,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ROUTER_THINKING_LEVELS, type ThinkingLevel, truncate } from "./constants.ts";
import { resolveRouterThinkingMap } from "./presets.ts";
import type { ThinkingLevelMap } from "./types.ts";

export interface SelectItem<T extends string = string> {
	value: T;
	label: string;
	description?: string;
	searchText?: string;
}

export function createSearchableSelector<T extends string>(opts: {
	title: string;
	subtitle?: string;
	items: ReadonlyArray<SelectItem<T>>;
	initialValue?: T;
	initialQuery?: string;
	maxVisible?: number;
	emptyMessage?: string;
}): (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T | undefined) => void) => Container {
	return (tui, theme, keybindings, done) => {
		const allItems = [...opts.items];
		let filteredItems = allItems;
		let selectedIndex = Math.max(
			0,
			allItems.findIndex((item) => item.value === opts.initialValue),
		);
		const maxVisible = Math.max(1, opts.maxVisible ?? 10);
		const input = new Input();
		if (opts.initialQuery) input.setValue(opts.initialQuery);
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const refresh = () => {
			list.clear();
			const start = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, filteredItems.length - maxVisible)),
			);
			const end = Math.min(start + maxVisible, filteredItems.length);
			for (let index = start; index < end; index++) {
				const item = filteredItems[index];
				if (!item) continue;
				const active = index === selectedIndex;
				const prefix = active ? theme.fg("accent", "→ ") : "  ";
				const label = theme.fg(active ? "accent" : "text", item.label);
				const description = item.description ? theme.fg("muted", `  ${truncate(item.description, 48)}`) : "";
				list.addChild(new TruncatedText(prefix + label + description, 1, 0));
			}
			if (filteredItems.length === 0) {
				list.addChild(new Text(theme.fg("muted", `  ${opts.emptyMessage ?? "No matching items"}`), 1, 0));
			} else if (start > 0 || end < filteredItems.length) {
				list.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filteredItems.length})`), 1, 0));
			}
			const hints = [
				rawKeyHint("type", "filter"),
				rawKeyHint("↑↓", "navigate"),
				keyHint("tui.select.confirm", "select"),
				keyHint("tui.select.cancel", "back"),
			];
			footer.setText(hints.join("  "));
			container.invalidate();
			tui.requestRender();
		};

		const applyFilter = (query: string, preferred?: T) => {
			filteredItems = query
				? fuzzyFilter(
						allItems,
						query,
						(item) => item.searchText ?? `${item.label} ${item.description ?? ""} ${item.value}`,
					)
				: allItems;
			const preferredIndex = preferred ? filteredItems.findIndex((item) => item.value === preferred) : -1;
			selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
			refresh();
		};

		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		container.addChild(new Spacer(1));
		container.addChild(new TruncatedText(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		if (opts.subtitle) container.addChild(new TruncatedText(theme.fg("muted", opts.subtitle), 1, 0));
		container.addChild(new Spacer(1));
		// Keep the search row mounted even when empty, matching /model and
		// preventing the list from jumping when the first character is typed.
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(footer);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		container.handleInput = (data: string) => {
			if (keybindings.matches(data, "tui.select.up")) {
				if (filteredItems.length > 0) {
					selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (filteredItems.length > 0) {
					selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				const item = filteredItems[selectedIndex];
				if (item) done(item.value);
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			}
			const before = input.getValue();
			input.handleInput(data);
			const after = input.getValue();
			if (after !== before) applyFilter(after);
		};

		applyFilter(opts.initialQuery ?? "", opts.initialValue);
		return container;
	};
}

export interface ModelChecklistItem {
	id: string;
	name?: string;
	unavailable?: boolean;
}

export function createModelChecklist(opts: {
	title: string;
	subtitle?: string;
	models: ReadonlyArray<ModelChecklistItem>;
	initiallySelected?: ReadonlySet<string>;
	/** Models that must remain selected while the checklist is open. */
	protectedIds?: ReadonlySet<string>;
	onChange?: (selectedIds: string[]) => void;
	onProtectedToggle?: (id: string) => void;
}): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: { kind: "close"; selectedIds: string[] }) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const items = opts.models.map((model) => ({
			id: model.id,
			label: model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id,
			unavailable: model.unavailable ?? false,
			protected: opts.protectedIds?.has(model.id) ?? false,
			searchText: `${model.id} ${model.name ?? ""} ${model.unavailable ? "not returned unavailable" : ""}`,
		}));
		const selected = new Set(opts.initiallySelected ?? []);
		let filter = "";
		let selectedIndex = 0;
		const maxVisible = 10;
		const input = new Input();
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const filtered = () => {
			const query = filter.trim();
			return query ? fuzzyFilter(items, query, (item) => item.searchText) : items;
		};

		const notifyChange = () => opts.onChange?.([...selected]);
		const selectionChanged = (before: ReadonlySet<string>): boolean =>
			before.size !== selected.size || [...before].some((id) => !selected.has(id));

		const refresh = () => {
			const rows = filtered();
			if (selectedIndex >= rows.length) selectedIndex = Math.max(0, rows.length - 1);
			list.clear();
			const start = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, rows.length - maxVisible)),
			);
			const end = Math.min(start + maxVisible, rows.length);
			for (let index = start; index < end; index++) {
				const item = rows[index]!;
				const active = index === selectedIndex;
				const mark = selected.has(item.id) ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const prefix = active ? theme.fg("accent", "→ ") : "  ";
				const label = theme.fg(active ? "accent" : "text", item.label);
				const availability = item.unavailable ? theme.fg("warning", "  (not returned)") : "";
				const current = item.protected ? theme.fg("success", "  (current)") : "";
				list.addChild(new TruncatedText(`${prefix}${mark} ${label}${availability}${current}`, 1, 0));
			}
			if (rows.length === 0) {
				list.addChild(new Text(theme.fg("muted", "  No matching models"), 1, 0));
			} else if (start > 0 || end < rows.length) {
				list.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${rows.length})`), 1, 0));
			}

			const statusLine = theme.fg("muted", `${selected.size} selected · ${rows.length} shown`);
			const hints = [
				keyHint("app.list.toggle", "toggle"),
				keyHint("app.models.enableAll", "all"),
				keyHint("app.models.clearAll", "none"),
				rawKeyHint("type", "filter"),
				keyHint("tui.select.confirm", "done"),
				keyHint("tui.select.cancel", "back"),
			];
			footer.setText(`${statusLine}\n${hints.join("  ")}`);
			container.invalidate();
			tui.requestRender();
		};

		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		container.addChild(new Spacer(1));
		container.addChild(new TruncatedText(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		if (opts.subtitle) container.addChild(new TruncatedText(theme.fg("muted", opts.subtitle), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(footer);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		container.handleInput = (data: string) => {
			const rows = filtered();
			if (keybindings.matches(data, "app.list.toggle")) {
				const item = rows[selectedIndex];
				if (item) {
					if (item.protected) {
						opts.onProtectedToggle?.(item.id);
						return;
					}
					if (selected.has(item.id)) selected.delete(item.id);
					else selected.add(item.id);
					notifyChange();
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "app.models.enableAll")) {
				const before = new Set(selected);
				for (const item of rows) selected.add(item.id);
				if (selectionChanged(before)) notifyChange();
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.clearAll")) {
				const before = new Set(selected);
				let protectedId: string | undefined;
				for (const item of rows) {
					if (item.protected) {
						protectedId ??= item.id;
						continue;
					}
					selected.delete(item.id);
				}
				if (protectedId) opts.onProtectedToggle?.(protectedId);
				if (selectionChanged(before)) notifyChange();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.up")) {
				if (rows.length > 0) {
					selectedIndex = selectedIndex === 0 ? rows.length - 1 : selectedIndex - 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (rows.length > 0) {
					selectedIndex = selectedIndex === rows.length - 1 ? 0 : selectedIndex + 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
				done({ kind: "close", selectedIds: [...selected] });
				return;
			}
			const before = input.getValue();
			input.handleInput(data);
			const after = input.getValue();
			if (after !== before) {
				filter = after;
				selectedIndex = 0;
				refresh();
			}
		};

		refresh();
		return container;
	};
}

export function createThinkingMapEditor(opts: {
	title: string;
	map: ThinkingLevelMap;
	levels?: ReadonlyArray<ThinkingLevel>;
	onChange?: (map: ThinkingLevelMap) => void;
}): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ThinkingLevelMap | undefined) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const levels = [...(opts.levels ?? ROUTER_THINKING_LEVELS)];
		const working = resolveRouterThinkingMap(opts.map);
		let index = 0;
		let mode: "levels" | "choice" | "target" = "levels";
		let choice = 0;
		const input = new Input();
		const container = new Container() as Container & { handleInput(data: string): void; focused: boolean };
		let focused = false;
		const refresh = () => {
			container.clear();
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.addChild(new Text(theme.fg("accent", opts.title), 1, 1));
			if (mode === "levels") {
				for (const [i, level] of levels.entries()) {
					const value = working[level];
					const status = value === undefined ? "Inherit" : value === null ? "Hidden" : `→ ${value}`;
					container.addChild(
						new TruncatedText(
							theme.fg(i === index ? "accent" : "text", `${i === index ? "→" : " "} ${level} · ${status}`),
							1,
							0,
						),
					);
				}
			} else if (mode === "choice") {
				container.addChild(new Text(theme.fg("muted", `${levels[index]} · mapping`), 1, 0));
				for (const [i, label] of [
					"Inherit (Pi default)",
					"String target (provider effort)",
					"Hidden (null)",
				].entries()) {
					container.addChild(
						new Text(theme.fg(i === choice ? "accent" : "text", `${i === choice ? "→" : " "} ${label}`), 1, 0),
					);
				}
			} else {
				container.addChild(new Text(theme.fg("muted", `${levels[index]} · non-empty provider effort`), 1, 0));
				container.addChild(input);
			}
			input.focused = focused && mode === "target";
			container.addChild(
				new Text(
					`${keyHint("tui.select.confirm", mode === "target" ? "save" : "edit")}  ${keyHint("tui.select.cancel", "back")}`,
					1,
					1,
				),
			);
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.invalidate();
			tui.requestRender();
		};
		const save = (value: string | null | undefined) => {
			const level = levels[index]!;
			if (value === undefined) delete working[level];
			else working[level] = value;
			opts.onChange?.({ ...working });
			mode = "levels";
			refresh();
		};
		Object.defineProperty(container, "focused", {
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				input.focused = value && mode === "target";
			},
		});
		container.handleInput = (data) => {
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (mode === "levels") done(undefined);
				else {
					mode = mode === "target" ? "choice" : "levels";
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				if (mode === "levels") {
					mode = "choice";
					choice = 0;
				} else if (mode === "choice") {
					if (choice === 0) return save(undefined);
					if (choice === 2) return save(null);
					mode = "target";
					input.setValue(working[levels[index]!] ?? "");
				} else {
					const value = input.getValue().trim();
					if (value) save(value);
					return;
				}
				refresh();
				return;
			}
			if (mode === "target") {
				input.handleInput(data);
				tui.requestRender();
				return;
			}
			const delta = keybindings.matches(data, "tui.select.up")
				? -1
				: keybindings.matches(data, "tui.select.down")
					? 1
					: 0;
			if (delta) {
				if (mode === "levels") index = (index + delta + levels.length) % levels.length;
				else choice = (choice + delta + 3) % 3;
				refresh();
			}
		};
		refresh();
		return container;
	};
}
