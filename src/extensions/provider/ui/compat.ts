/**
 * Compat pane: entries are `Key: Value` rows whose Key comes from the known
 * field catalog of the model's effective API (picker, no arbitrary top-level
 * keys). Open dictionaries (chatTemplateKwargs/chatTemplateArgs) nest one
 * level deeper and allow free keys per the schema.
 */

import "../keybindings.ts";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { type CompatField, compatFieldFor, compatFieldsForApi, validateJsonCompatValue } from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { moveSelection } from "./controls.ts";
import { compatObject, DictPane, scalarText } from "./dictionary.ts";
import type { CompatFields, EditorPane, PaneHost, ProviderPaneHost } from "./pane.ts";
import {
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	renderSearchLine,
	type ScrollWindowInfo,
	ValueEditor,
} from "./value-row.ts";

type CompatMode =
	| { type: "list" }
	| { type: "editValue"; key: string; editor: ValueEditor }
	| { type: "chooseValue"; key: string; options: readonly string[]; index: number };

export class CompatPane implements EditorPane {
	readonly crumb = "compat";
	private index = 0;
	private mode: CompatMode = { type: "list" };
	private error: string | undefined;
	private focused = false;

	private readonly host: ProviderPaneHost;
	private readonly model: CompatFields;
	constructor(host: ProviderPaneHost, model: CompatFields) {
		this.host = host;
		this.model = model;
	}

	private entries(): [string, unknown][] {
		return Object.entries(compatObject(this.model));
	}

	private effectiveApi(): string | undefined {
		return this.host.effectiveApi(this.model.read());
	}

	/** Entry rows plus the trailing "+ Add entry" action. */
	private rowCount(): number {
		return this.entries().length + 1;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const api = this.effectiveApi();
		const lines: string[] = [
			renderInfoLine(theme, api ? `effective api: ${api}` : "effective api: unresolved — set API Type", width),
		];
		if (this.mode.type === "chooseValue") {
			const mode = this.mode;
			const note = api ? compatFieldFor(api, mode.key)?.note : undefined;
			const current = compatObject(this.model)[mode.key];
			lines.push(renderInfoLine(theme, note ? `${mode.key} · ${note}` : mode.key, width));
			for (const [index, option] of mode.options.entries()) {
				lines.push(
					renderPlainLine(theme, `${String(current) === option ? "●" : "○"} ${option}`, {
						active: index === mode.index,
						paneFocused: this.focused,
						width,
					}),
				);
			}
			return lines;
		}
		const known = api ? compatFieldsForApi(api) : [];
		const entries = this.entries();
		const editingKey = this.mode.type === "list" ? undefined : this.mode.key;
		if (editingKey !== undefined && !entries.some(([key]) => key === editingKey))
			entries.push([editingKey, undefined]);
		if (known.length === 0 && entries.length === 0) {
			lines.push(renderInfoLine(theme, `No compat fields are known for ${api ?? "this api"}.`, width));
		}
		// All entries render; the editor's fixed window scrolls around scrollWindow().
		for (const [rowIndex, [key, value]] of entries.entries()) {
			const active = rowIndex === this.index;
			const field = api ? compatFieldFor(api, key) : undefined;
			const editing = this.mode.type === "editValue" && this.mode.key === key ? this.mode.editor : undefined;
			const note = field ? undefined : `· not used by ${api ?? "this api"}`;
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: key,
					valueText: value === undefined ? "not set" : scalarText(value),
					active,
					paneFocused: this.focused,
					editing,
					note,
					width,
				}),
			);
		}
		lines.push(
			renderPlainLine(theme, "+ Add entry", {
				active: this.index === entries.length && this.mode.type === "list",
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		// What the selected key does, since its name alone rarely says; a blank line keeps it from reading as a row.
		const about = this.selectedNote();
		if (about) lines.push("", renderInfoLine(theme, about, width));
		return lines;
	}

	private selectedNote(): string | undefined {
		const api = this.effectiveApi();
		const key = this.entries()[this.index]?.[0];
		return api && key ? compatFieldFor(api, key)?.note : undefined;
	}

	scrollWindow(): ScrollWindowInfo {
		// The effective-api header pins above; errors and the selected key's description pin below.
		if (this.mode.type === "chooseValue") return { top: 1, cursor: 2 + this.mode.index };
		return { top: 1, bottom: (this.error ? 1 : 0) + (this.selectedNote() ? 2 : 0), cursor: 1 + this.index };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.mode.type === "editValue") {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.mode.editor.handleInput(data);
			this.host.refresh();
			return;
		}
		if (this.mode.type === "chooseValue") {
			const mode = this.mode;
			if (kb.matches(data, "tui.select.up")) {
				this.mode = { ...mode, index: mode.index === 0 ? mode.options.length - 1 : mode.index - 1 };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.mode = { ...mode, index: (mode.index + 1) % mode.options.length };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.mode = { type: "list" };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const option = mode.options[mode.index]!;
				this.mode = { type: "list" };
				this.writeValue(mode.key, this.parseChosen(option));
			}
			return;
		}
		// list mode
		const next = moveSelection(kb, data, this.index, this.rowCount());
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "app.provider.removeEntry")) {
			const entry = this.entries()[this.index];
			if (!entry) return;
			const [key] = entry;
			this.model.setField(["compat", key], DELETE);
			this.index = Math.min(this.index, this.rowCount() - 2 < 0 ? 0 : this.rowCount() - 2);
			return;
		}
		if (kb.matches(data, "app.list.toggle") || kb.matches(data, "tui.select.confirm")) {
			this.activateRow();
			return;
		}
	}

	private activateRow(): void {
		const entries = this.entries();
		if (this.index === entries.length) {
			const api = this.effectiveApi();
			if (!api) {
				this.fail("Set API Type first — compat fields depend on the effective api.");
				return;
			}
			const known = compatFieldsForApi(api);
			if (known.length === 0) {
				this.fail(`No compat fields are known for ${api}.`);
				return;
			}
			const taken = new Set(entries.map(([key]) => key));
			this.host.pushPane(new CompatKeyPickerPane(this.host, api, taken, (key) => this.beginValueEntry(key)));
			return;
		}
		const [key, value] = entries[this.index]!;
		const field = this.effectiveApi() ? compatFieldFor(this.effectiveApi()!, key) : undefined;
		if (!field) {
			// unknown/foreign key: raw JSON edit
			this.beginJsonEdit(key, value);
			return;
		}
		switch (field.kind) {
			case "boolean":
				this.writeValue(key, value !== true);
				return;
			case "enum":
				this.mode = {
					type: "chooseValue",
					key,
					options: field.options,
					index: Math.max(0, field.options.indexOf(String(value))),
				};
				this.host.refresh();
				return;
			case "number":
				this.beginTextEdit(key, value);
				return;
			case "json":
				this.beginJsonEdit(key, value);
				return;
			case "stringMap":
				this.host.pushPane(new DictPane(this.host, this.model, key));
				return;
		}
	}

	/** After picking a key in the picker: enter the value flow for its kind. */
	private beginValueEntry(key: string): void {
		const api = this.effectiveApi()!;
		const field = compatFieldFor(api, key)!;
		switch (field.kind) {
			case "boolean":
				this.mode = { type: "chooseValue", key, options: ["true", "false"], index: 0 };
				this.host.refresh();
				return;
			case "enum":
				this.mode = { type: "chooseValue", key, options: field.options, index: 0 };
				this.host.refresh();
				return;
			case "number":
				this.beginTextEdit(key, undefined);
				return;
			case "json":
				this.beginJsonEdit(key, undefined);
				return;
			case "stringMap":
				// Materialize an empty dictionary, then open it for entries.
				this.writeValue(key, {});
				this.host.pushPane(new DictPane(this.host, this.model, key));
				return;
		}
	}

	private beginTextEdit(key: string, current: unknown): void {
		const editor = new ValueEditor({
			onCommit: (raw) => {
				const parsed = Number(raw.trim());
				if (!Number.isFinite(parsed)) {
					this.error = `${key} must be a number.`;
					return this.host.refresh();
				}
				this.error = undefined;
				this.mode = { type: "list" };
				this.writeValue(key, parsed);
			},
			onCancel: () => {
				this.mode = { type: "list" };
				this.error = undefined;
				this.host.refresh();
			},
		});
		if (current !== undefined) editor.beginTweak(String(current));
		editor.focused = this.focused;
		this.mode = { type: "editValue", key, editor };
		this.host.refresh();
	}

	private beginJsonEdit(key: string, current: unknown): void {
		const editor = new ValueEditor({
			onCommit: (raw) => {
				const text = raw.trim();
				if (!text) {
					this.mode = { type: "list" };
					this.writeValue(key, DELETE);
					return;
				}
				const shapeError = validateJsonCompatValue(this.effectiveApi(), key, text);
				if (shapeError) {
					this.error = shapeError;
					return this.host.refresh();
				}
				this.error = undefined;
				this.mode = { type: "list" };
				this.writeValue(key, JSON.parse(text));
			},
			onCancel: () => {
				this.mode = { type: "list" };
				this.error = undefined;
				this.host.refresh();
			},
		});
		if (current !== undefined) editor.beginTweak(JSON.stringify(current));
		editor.focused = this.focused;
		this.mode = { type: "editValue", key, editor };
		this.host.refresh();
	}

	private parseChosen(option: string): unknown {
		if (option === "true") return true;
		if (option === "false") return false;
		return option;
	}

	private writeValue(key: string, value: unknown): void {
		this.model.setField(["compat", key], value);
	}

	private fail(message: string): void {
		this.error = message;
		this.host.refresh();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.mode.type === "editValue") this.mode.editor.focused = focused;
	}

	isEditing(): boolean {
		return this.mode.type === "editValue";
	}

	hints(): string {
		if (this.mode.type === "editValue")
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		if (this.mode.type === "chooseValue")
			return [
				rawKeyHint("↑↓", "navigate"),
				keyHint("tui.select.confirm", "set"),
				keyHint("tui.select.cancel", "cancel"),
			].join("  ");
		const back = keyHint("tui.select.cancel", "back");
		const entry = this.entries()[this.index];
		if (!entry) return [keyHint("tui.select.confirm", "add"), back].join("  ");
		return [
			keyHint("tui.select.confirm", this.rowVerb(entry[0])),
			keyHint("app.provider.removeEntry", "remove"),
			back,
		].join("  ");
	}

	/** What Enter does to an entry: its kind decides, and a key the API does not know edits as JSON. */
	private rowVerb(key: string): string {
		const api = this.effectiveApi();
		switch (api ? compatFieldFor(api, key)?.kind : undefined) {
			case "boolean":
				return "toggle";
			case "enum":
				return "choose";
			case "stringMap":
				return "open";
			default:
				return "edit";
		}
	}
}

// -------------------------------------------------------------------------
// Known-key picker (searchable, filters already-configured keys)
// -------------------------------------------------------------------------

export class CompatKeyPickerPane implements EditorPane {
	readonly crumb = "compat · new entry";
	private query = "";
	private index = 0;
	private editor: ValueEditor;
	private focused = false;

	private readonly host: PaneHost;
	private readonly api: string;
	private readonly taken: ReadonlySet<string>;
	private readonly onPick: (key: string) => void;

	constructor(host: PaneHost, api: string, taken: ReadonlySet<string>, onPick: (key: string) => void) {
		this.host = host;
		this.api = api;
		this.taken = taken;
		this.onPick = onPick;

		this.editor = new ValueEditor({
			onCommit: () => this.pickCurrent(),
			onCancel: () => this.host.popPane(),
		});
	}

	private candidates(): CompatField[] {
		const available = compatFieldsForApi(this.api).filter((field) => !this.taken.has(field.key));
		const query = this.query.trim();
		return query ? fuzzyFilter(available, query, (field) => `${field.key} ${field.note ?? ""}`) : available;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [renderSearchLine(theme, this.editor, this.focused, width)];
		const candidates = this.candidates();
		if (candidates.length === 0) lines.push(renderInfoLine(theme, "No remaining known fields.", width));
		// All candidates render; the editor's fixed window scrolls around scrollWindow().
		for (const [rowIndex, field] of candidates.entries()) {
			lines.push(
				renderPlainLine(theme, field.key, {
					active: rowIndex === this.index,
					paneFocused: this.focused,
					// The description is what tells similar keys apart; the row cuts at the pane edge, not at 30 characters.
					note: field.note ? `· ${field.note}` : `· ${field.kind}`,
					width,
				}),
			);
		}
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The filter input pins above the candidate rows.
		return { top: 1, cursor: 1 + this.index };
	}

	private pickCurrent(): void {
		const field = this.candidates()[this.index];
		if (!field) return;
		this.host.popPane();
		this.onPick(field.key);
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			const count = this.candidates().length;
			if (count > 0) this.index = this.index === 0 ? count - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			const count = this.candidates().length;
			if (count > 0) this.index = (this.index + 1) % count;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.pickCurrent();
			return;
		}
		const before = this.query;
		this.editor.handleInput(data);
		this.query = this.editor.value;
		if (this.query !== before) this.index = 0;
		this.host.refresh();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.editor.focused = focused;
	}

	isEditing(): boolean {
		return true; // the filter input always owns ←/→
	}

	hints(): string {
		return [
			rawKeyHint("type", "filter"),
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "choose"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
