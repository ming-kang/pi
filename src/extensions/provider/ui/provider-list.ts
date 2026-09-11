/**
 * Provider list: the /provider entry screen. A searchable list of the
 * providers in models.json plus "+ New Provider"; selecting one opens the
 * two-pane editor. In "new provider" mode the search row becomes the id input.
 */

import { type Component, Container, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { truncate } from "../constants.ts";
import type { ModelsJsonStore } from "../store.ts";
import { renderInfoLine, renderPlainLine, ValueEditor } from "./value-row.ts";

const MAX_VISIBLE = 12;

export type ProviderListResult = { kind: "open"; providerId: string } | { kind: "close" };

function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).host;
	} catch {
		return undefined;
	}
}

/** A width-rendered list of line strings computed on demand. */
class Lines implements Component {
	private cached: { width: number; lines: string[] } | undefined;
	private readonly compute: (width: number) => string[];
	constructor(compute: (width: number) => string[]) {
		this.compute = compute;
	}
	invalidate(): void {
		this.cached = undefined;
	}
	render(width: number): string[] {
		if (!this.cached || this.cached.width !== width) {
			this.cached = { width, lines: this.compute(width) };
		}
		return this.cached.lines;
	}
}

export function createProviderListScreen(opts: {
	store: ModelsJsonStore;
}): (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: ProviderListResult) => void) => Container {
	return (tui, theme, keybindings, done) => {
		const input = new ValueEditor(keybindings, {
			// Enter/Esc are intercepted before the input sees them.
			onCommit: () => {},
			onCancel: () => {},
		});
		let mode: "list" | "newProvider" = "list";
		let query = "";
		let index = 0;
		let error: string | undefined;
		let focused = false;

		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const filtered = () => {
			const ids = opts.store.getProviderIds();
			const q = query.trim().toLowerCase();
			return q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
		};

		const renderBody = (width: number): string[] => {
			const lines: string[] = [];
			if (mode === "newProvider") {
				lines.push(renderInfoLine(theme, "New provider id:", width));
				lines.push(input.renderLine(width));
			} else {
				lines.push(input.renderLine(width));
			}
			lines.push("");
			if (mode === "list") {
				const entries = filtered();
				const total = entries.length + 1;
				const start = Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE / 2), Math.max(0, total - MAX_VISIBLE)));
				const end = Math.min(start + MAX_VISIBLE, total);
				for (let rowIndex = start; rowIndex < end; rowIndex++) {
					if (rowIndex === 0) {
						lines.push(
							renderPlainLine(theme, "+ New Provider", { active: index === 0, paneFocused: focused, width }),
						);
						continue;
					}
					const id = entries[rowIndex - 1]!;
					const provider = opts.store.getProvider(id);
					const models = provider?.models?.length ?? 0;
					const host = hostOf(provider?.baseUrl);
					const note = [models ? `${models} model${models === 1 ? "" : "s"}` : undefined, host, provider?.api]
						.filter(Boolean)
						.join(" · ");
					lines.push(
						renderPlainLine(theme, id, {
							active: index === rowIndex,
							paneFocused: focused,
							note: note || undefined,
							width,
						}),
					);
				}
				if (entries.length === 0) {
					lines.push(
						renderInfoLine(theme, query ? "No matching providers." : "No providers in models.json yet.", width),
					);
				}
			}
			if (error) lines.push(theme.fg("error", truncate(error, Math.max(10, width - 2))));
			return lines;
		};

		const renderHints = (): string => {
			if (mode === "newProvider") {
				return [keyHint("tui.input.submit", "create"), keyHint("tui.select.cancel", "cancel")].join("  ");
			}
			return [
				rawKeyHint("type", "filter"),
				rawKeyHint("↑↓", "move"),
				keyHint("tui.select.confirm", "open"),
				keyHint("tui.select.cancel", "close"),
			].join("  ");
		};

		const refresh = () => {
			container.clear();
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.addChild(new Title(theme, ` /provider — models.json providers`));
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.addChild(new Lines(renderBody));
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.addChild(new Lines(() => [renderHints()]));
			container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
			container.invalidate();
			tui.requestRender();
		};

		const moveSelection = (delta: number) => {
			const total = filtered().length + 1;
			index = (index + delta + total) % total;
		};

		container.handleInput = (data: string) => {
			if (mode === "newProvider") {
				if (keybindings.matches(data, "tui.select.cancel")) {
					mode = "list";
					error = undefined;
					input.reset(query);
					return refresh();
				}
				if (keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") {
					const id = input.value.trim();
					if (!id) {
						error = "Provider id must be non-empty.";
						return refresh();
					}
					if (opts.store.getProvider(id)) {
						error = `Provider "${id}" already exists.`;
						return refresh();
					}
					opts.store.ensureProviderView(id);
					done({ kind: "open", providerId: id });
					return;
				}
				input.handleInput(data);
				return refresh();
			}
			// list mode
			if (keybindings.matches(data, "tui.select.up")) {
				moveSelection(-1);
				return refresh();
			}
			if (keybindings.matches(data, "tui.select.down")) {
				moveSelection(1);
				return refresh();
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				done({ kind: "close" });
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				if (index === 0) {
					mode = "newProvider";
					error = undefined;
					input.reset("");
					return refresh();
				}
				const id = filtered()[index - 1];
				if (id) done({ kind: "open", providerId: id });
				return;
			}
			// Everything else (printable chars, backspace, …) goes to the filter input.
			const before = query;
			input.handleInput(data);
			query = input.value;
			if (query !== before) index = 0;
			return refresh();
		};

		Object.defineProperty(container, "focused", {
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				input.focused = value;
			},
		});

		refresh();
		return container;
	};
}

class Title implements Component {
	private readonly theme: Theme;
	private readonly title: string;
	constructor(theme: Theme, title: string) {
		this.theme = theme;
		this.title = title;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), width)];
	}
}
