/** Searchable provider list and new-provider id entry. */

import { type Component, type Focusable, fuzzyFilter, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { builtinModelIds, builtinProviderIds, isBuiltinProviderId } from "../catalog.ts";
import { plural } from "../constants.ts";
import type { ModelsJsonStore } from "../store.ts";
import {
	frameBodyRows,
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	ValueEditor,
	windowLines,
} from "./value-row.ts";

/** Why a typed id can never name a provider. */
function invalidIdReason(id: string): string | undefined {
	// provider/model references match known ids longest first, so an inner "/" resolves (upstream v1.5.0).
	// A leading "/" is almost always a slash command typed into the open panel.
	if (/\s/.test(id)) return "Provider ids cannot contain spaces.";
	return id.startsWith("/") ? 'Provider ids cannot start with "/".' : undefined;
}

/** Lines the search input and its spacer take from the body, so the frame matches the provider editor's. */
const ROWS_ABOVE_LIST = 2;
const MORE_LABEL = "More built-in providers";
export type ProviderListResult = { kind: "open"; providerId: string } | { kind: "close" };

/** Which built-in providers count as configured, and how each authenticates. */
export interface ProviderListContext {
	/** Built-in providers with a credential or a models.json entry. */
	readonly configured: readonly string[];
	/** Short credential source for a built-in, e.g. "API key", "OAuth", "env DEEPSEEK_API_KEY". */
	authNote(providerId: string): string | undefined;
}

type Row = { kind: "add" } | { kind: "provider"; id: string; unconfigured?: boolean } | { kind: "more"; count: number };

/**
 * The list shows what is set up: custom providers and configured built-ins.
 * Unconfigured built-ins sit behind a dim "More built-in providers" row, and
 * a search reaches them from the main list too, so typing "openai" finds it
 * without knowing where it lives.
 */
export class ProviderListScreen implements Component, Focusable {
	private readonly input: ValueEditor;
	private readonly store: ModelsJsonStore;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: ProviderListResult) => void;
	private readonly context: ProviderListContext;
	private mode: "list" | "more" | "newProvider" = "list";
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
		context: ProviderListContext,
		/** The provider to start on, e.g. the one whose editor was just left. */
		selectId?: string,
	) {
		this.context = context;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.store = store;
		this.input = new ValueEditor({ onCommit: () => this.confirm(), onCancel: () => this.cancel() });
		this.index = Math.max(
			0,
			this.rows().findIndex((row) => row.kind === "provider" && row.id === selectId),
		);
	}

	get focused(): boolean {
		return this.active;
	}
	set focused(value: boolean) {
		this.active = value;
		this.input.focused = value;
	}
	invalidate(): void {}

	/** Custom providers first (edited most), then configured built-ins. */
	private listed(): string[] {
		const custom = this.store.getProviderIds().filter((id) => !isBuiltinProviderId(id));
		return [...new Set([...custom, ...this.context.configured])];
	}

	private unconfigured(): string[] {
		const listed = new Set(this.listed());
		return builtinProviderIds().filter((id) => !listed.has(id));
	}

	private rows(): Row[] {
		const query = this.query.trim();
		if (this.mode === "more") {
			const ids = query ? fuzzyFilter(this.unconfigured(), query, (id) => id) : this.unconfigured();
			return ids.map((id) => ({ kind: "provider", id }));
		}
		const rows: Row[] = [{ kind: "add" }];
		if (!query) {
			rows.push(...this.listed().map((id): Row => ({ kind: "provider", id })));
			const count = this.unconfigured().length;
			if (count > 0) rows.push({ kind: "more", count });
			return rows;
		}
		const match = (ids: string[]) => fuzzyFilter(ids, query, (id) => id);
		rows.push(...match(this.listed()).map((id): Row => ({ kind: "provider", id })));
		rows.push(...match(this.unconfigured()).map((id): Row => ({ kind: "provider", id, unconfigured: true })));
		return rows;
	}

	/** Custom providers stay bare; built-ins say how they authenticate. */
	private note(row: Extract<Row, { kind: "provider" }>): string | undefined {
		const id = row.id;
		const parts: string[] = [];
		if (this.mode === "more") {
			const count = builtinModelIds(id).length;
			parts.push(`${count} ${plural(count, "model")}`);
		} else if (row.unconfigured) {
			parts.push("built-in", "not configured");
		} else if (isBuiltinProviderId(id)) {
			parts.push("built-in");
			const auth = this.context.authNote(id);
			if (auth) parts.push(auth);
			if (this.store.getProviderIds().includes(id)) parts.push("customized");
		}
		return parts.length > 0 ? `· ${parts.join(" · ")}` : undefined;
	}

	private renderRow(row: Row, active: boolean, width: number): string {
		const theme = this.theme;
		const paneFocused = this.active;
		if (row.kind === "add") return renderPlainLine(theme, "+ Add provider", { active, paneFocused, width });
		if (row.kind === "more")
			return renderPlainLine(theme, MORE_LABEL, {
				active,
				paneFocused,
				dim: !active,
				note: `· ${row.count}`,
				width,
			});
		return renderKeyValueLine(theme, {
			valueText: row.id,
			unset: row.unconfigured,
			note: this.note(row),
			active,
			paneFocused,
			width,
		});
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = new DynamicBorder((text) => theme.fg("border", text)).render(width)[0] ?? "";
		const title = {
			list: " Providers",
			more: ` Providers / ${MORE_LABEL}`,
			newProvider: " Providers / New provider",
		}[this.mode];
		const lines = [
			border,
			truncateToWidth(theme.fg("accent", theme.bold(title)), width),
			border,
			renderKeyValueLine(theme, {
				keyLabel: this.mode === "newProvider" ? "Provider id" : "Search",
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
		const listRows = frameBodyRows(this.tui) - ROWS_ABOVE_LIST;
		if (this.mode === "newProvider") {
			const id = this.input.value.trim();
			// An id that can never work says so while typing, instead of naming the key it would become.
			const problem = id ? invalidIdReason(id) : undefined;
			if (problem) area.push(truncateToWidth(theme.fg("error", problem), width));
			else
				area.push(
					renderInfoLine(
						theme,
						!id
							? "Choose a unique provider id."
							: isBuiltinProviderId(id)
								? `${id} is built in; Enter opens it to customize.`
								: `This becomes the providers.${id} key in models.json.`,
						width,
					),
				);
			if (this.error && this.error !== problem) area.push(truncateToWidth(theme.fg("error", this.error), width));
		} else {
			const rows = this.rows();
			this.index = Math.min(this.index, Math.max(0, rows.length - 1));
			const rendered = rows.map((row, index) => this.renderRow(row, index === this.index, width));
			// A blank line sets the More row apart from the providers above it.
			const more = rows.findIndex((row) => row.kind === "more");
			if (more > 0) rendered.splice(more, 0, "");
			const cursor = more > 0 && this.index >= more ? this.index + 1 : this.index;
			const query = this.query.trim();
			if (this.mode === "more" && rows.length === 0) {
				rendered.push(renderInfoLine(theme, `No built-in providers match "${query}".`, width));
			} else if (this.mode === "list" && rows.length === 1) {
				const problem = query ? invalidIdReason(query) : undefined;
				rendered.push(
					renderInfoLine(theme, query ? `No providers match "${query}".` : "No providers configured.", width),
					problem
						? truncateToWidth(theme.fg("error", problem), width)
						: renderInfoLine(
								theme,
								query ? `Enter will create provider "${query}".` : "Enter starts a new provider.",
								width,
							),
				);
			}
			// The indicator counts rows, not the spacer line.
			const indicator = () => theme.fg("dim", `  (${this.index + 1}/${rows.length})`);
			area.push(...windowLines(theme, rendered, listRows, { cursor }, indicator));
		}
		while (area.length < listRows) area.push("");
		const hints =
			this.mode === "newProvider"
				? [keyHint("tui.input.submit", "create"), keyHint("tui.select.cancel", "cancel")]
				: [
						rawKeyHint("type", "search"),
						rawKeyHint("↑↓", "navigate"),
						keyHint("tui.select.confirm", "open"),
						keyHint("tui.select.cancel", this.mode === "more" ? "back" : "close"),
					];
		return [...lines, ...area, border, truncateToWidth(hints.join("  "), width), border];
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}
		if (this.mode === "newProvider") {
			this.input.handleInput(data);
		} else {
			const total = Math.max(1, this.rows().length);
			if (kb.matches(data, "tui.select.up")) this.index = (this.index + total - 1) % total;
			else if (kb.matches(data, "tui.select.down")) this.index = (this.index + 1) % total;
			else if (kb.matches(data, "tui.select.confirm")) {
				this.confirm();
				return;
			} else {
				const previous = this.query;
				this.input.handleInput(data);
				this.query = this.input.value;
				// A search lands on its first match; the main list keeps + Add provider at row 0.
				if (this.query !== previous)
					this.index = this.mode === "list" && this.query && this.rows().length > 1 ? 1 : 0;
			}
		}
		this.tui.requestRender();
	}

	private confirm(): void {
		if (this.mode === "newProvider") {
			this.error = this.create(this.input.value.trim());
			this.tui.requestRender();
			return;
		}
		const rows = this.rows();
		const row = rows[this.index];
		if (row?.kind === "provider") this.done({ kind: "open", providerId: row.id });
		else if (row?.kind === "more") this.enterMore();
		else if (row?.kind === "add") {
			// A fruitless search is the new id — type once, Enter once.
			const query = this.query.trim();
			const fruitless = query !== "" && rows.length === 1;
			this.error = fruitless ? this.create(query) : undefined;
			if (!fruitless || this.error) {
				this.mode = "newProvider";
				this.input.reset(this.query);
			}
		}
		this.tui.requestRender();
	}

	private enterMore(): void {
		// The More row only shows without a search, so the sub-list starts with an empty one.
		this.mode = "more";
		this.query = "";
		this.input.reset("");
		this.index = 0;
	}

	/** Open a new provider; returns why the id cannot be used. */
	private create(id: string): string | undefined {
		if (!id) return "Provider id is required.";
		const problem = invalidIdReason(id);
		if (problem) return problem;
		if (this.store.getProviderIds().includes(id)) return `Provider "${id}" already exists.`;
		this.store.ensureProviderView(id);
		this.done({ kind: "open", providerId: id });
		return undefined;
	}

	private cancel(): void {
		if (this.mode === "list") {
			this.done({ kind: "close" });
			return;
		}
		if (this.mode === "more") {
			// Back on the More row.
			this.query = "";
			this.mode = "list";
			this.index = Math.max(
				0,
				this.rows().findIndex((row) => row.kind === "more"),
			);
		} else this.mode = "list";
		this.error = undefined;
		this.input.reset(this.query);
		this.tui.requestRender();
	}
}
