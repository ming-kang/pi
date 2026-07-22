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
import { THINKING_LEVELS, type ThinkingLevel, truncate } from "./constants.ts";
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
		const search = new Container();
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const refresh = () => {
			search.clear();
			if (input.getValue()) {
				search.addChild(input);
				search.addChild(new Spacer(1));
			}
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
				keyHint("tui.select.cancel", input.getValue() ? "clear filter" : "back"),
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
		container.addChild(search);
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
				if (input.getValue()) {
					input.setValue("");
					applyFilter("");
					return;
				}
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

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

export function createModelChecklist(opts: {
	title: string;
	subtitle?: string;
	models: ReadonlyArray<{ id: string; name?: string }>;
	initiallySelected?: ReadonlySet<string>;
}): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: { kind: "save"; selectedIds: string[] } | { kind: "cancel" }) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const items = opts.models.map((model) => ({
			id: model.id,
			label: model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id,
		}));
		const initialSelected = new Set(opts.initiallySelected ?? []);
		const selected = new Set(initialSelected);
		let filter = "";
		let selectedIndex = 0;
		let discardArmed = false;
		const maxVisible = 12;
		const input = new Input();
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const isDirty = () => !sameIdSet(selected, initialSelected);

		const filtered = () => {
			const q = filter.trim().toLowerCase();
			if (!q) return items;
			return items.filter((item) => item.id.toLowerCase().includes(q) || item.label.toLowerCase().includes(q));
		};

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
				list.addChild(new TruncatedText(`${prefix}${mark} ${label}`, 1, 0));
			}
			if (rows.length === 0) {
				list.addChild(new Text(theme.fg("muted", "  No matching models"), 1, 0));
			}

			const statusParts = [`${selected.size} selected`, `${rows.length} shown`];
			if (isDirty()) statusParts.push(theme.fg("warning", "unsaved"));
			const statusLine = theme.fg("muted", statusParts.join(" · "));

			let hints: string[];
			if (discardArmed && isDirty()) {
				hints = [
					theme.fg("warning", "Unsaved selection — Esc again discards"),
					keyHint("app.models.save", "apply"),
				];
			} else {
				hints = [
					keyHint("app.list.toggle", "toggle"),
					keyHint("app.models.enableAll", "all"),
					keyHint("app.models.clearAll", "none"),
					keyHint("app.models.save", "apply"),
					rawKeyHint("type", "filter"),
					keyHint("tui.select.cancel", filter ? "clear" : isDirty() ? "warn discard" : "cancel"),
				];
			}
			footer.setText(`${statusLine}\n${hints.join("  ")}`);
			container.invalidate();
			tui.requestRender();
		};

		const markChanged = () => {
			discardArmed = false;
			refresh();
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
					if (selected.has(item.id)) selected.delete(item.id);
					else selected.add(item.id);
					markChanged();
				}
				return;
			}
			if (keybindings.matches(data, "app.models.enableAll")) {
				for (const item of rows) selected.add(item.id);
				markChanged();
				return;
			}
			if (keybindings.matches(data, "app.models.clearAll")) {
				for (const item of rows) selected.delete(item.id);
				markChanged();
				return;
			}
			if (keybindings.matches(data, "app.models.save")) {
				done({ kind: "save", selectedIds: [...selected] });
				return;
			}
			if (keybindings.matches(data, "tui.select.up")) {
				if (rows.length > 0) {
					selectedIndex = selectedIndex === 0 ? rows.length - 1 : selectedIndex - 1;
					discardArmed = false;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (rows.length > 0) {
					selectedIndex = selectedIndex === rows.length - 1 ? 0 : selectedIndex + 1;
					discardArmed = false;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (filter) {
					filter = "";
					input.setValue("");
					selectedIndex = 0;
					discardArmed = false;
					refresh();
					return;
				}
				if (isDirty() && !discardArmed) {
					discardArmed = true;
					refresh();
					return;
				}
				done({ kind: "cancel" });
				return;
			}
			const before = input.getValue();
			input.handleInput(data);
			const after = input.getValue();
			if (after !== before) {
				filter = after;
				selectedIndex = 0;
				discardArmed = false;
				refresh();
			}
		};

		refresh();
		return container;
	};
}

function thinkingMapsEqual(a: ThinkingLevelMap, b: ThinkingLevelMap): boolean {
	for (const level of THINKING_LEVELS) {
		const av = Object.hasOwn(a, level) ? a[level] : undefined;
		const bv = Object.hasOwn(b, level) ? b[level] : undefined;
		if (av !== bv) return false;
	}
	return true;
}

export function createThinkingMapEditor(opts: {
	title: string;
	map: ThinkingLevelMap;
}): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ThinkingLevelMap | undefined) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const initial: ThinkingLevelMap = { ...opts.map };
		const working: ThinkingLevelMap = { ...opts.map };
		let index = 0;
		let discardArmed = false;
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const isDirty = () => !thinkingMapsEqual(working, initial);

		const status = (level: ThinkingLevel): string => {
			const value = working[level];
			if (value === null) return "hidden";
			if (value === undefined) return "default";
			return value === level ? "on" : `→ ${value}`;
		};

		const refresh = () => {
			list.clear();
			for (let i = 0; i < THINKING_LEVELS.length; i++) {
				const level = THINKING_LEVELS[i]!;
				const active = i === index;
				const prefix = active ? theme.fg("accent", "→ ") : "  ";
				const label = theme.fg(active ? "accent" : "text", level.padEnd(8));
				const st = status(level);
				const color = st === "hidden" ? "muted" : st === "default" ? "dim" : "success";
				list.addChild(new Text(`${prefix}${label} ${theme.fg(color, st)}`, 1, 0));
			}

			const statusLine = isDirty() ? theme.fg("warning", "Unsaved changes") : theme.fg("muted", "No changes yet");

			let hints: string[];
			if (discardArmed && isDirty()) {
				hints = [theme.fg("warning", "Esc again discards"), keyHint("app.models.save", "apply")];
			} else {
				hints = [
					keyHint("app.list.toggle", "toggle on/hidden"),
					keyHint("tui.select.confirm", "toggle on/hidden"),
					keyHint("app.models.save", "apply"),
					keyHint("tui.select.cancel", isDirty() ? "warn discard" : "back"),
				];
			}
			footer.setText(`${statusLine}\n${hints.join("  ")}`);
			container.invalidate();
			tui.requestRender();
		};

		const toggle = () => {
			const level = THINKING_LEVELS[index]!;
			if (working[level] === null) {
				working[level] = level === "off" ? "none" : level;
			} else {
				working[level] = null;
			}
			discardArmed = false;
			refresh();
		};

		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		container.addChild(new Spacer(1));
		container.addChild(new TruncatedText(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		container.addChild(new Text(theme.fg("muted", "  Toggle which Pi thinking levels this model exposes."), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(footer);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => true,
			set: () => {},
		});

		container.handleInput = (data: string) => {
			if (keybindings.matches(data, "tui.select.up")) {
				index = index === 0 ? THINKING_LEVELS.length - 1 : index - 1;
				discardArmed = false;
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				index = index === THINKING_LEVELS.length - 1 ? 0 : index + 1;
				discardArmed = false;
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.list.toggle") || keybindings.matches(data, "tui.select.confirm")) {
				toggle();
				return;
			}
			if (keybindings.matches(data, "app.models.save")) {
				done({ ...working });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (isDirty() && !discardArmed) {
					discardArmed = true;
					refresh();
					return;
				}
				done(undefined);
			}
		};

		refresh();
		return container;
	};
}
