/**
 * Compat pane: entries are `Key: Value` rows whose Key comes from the known
 * field catalog of the model's effective API (picker, no arbitrary top-level
 * keys). Open dictionaries (chatTemplateKwargs/chatTemplateArgs) nest one
 * level deeper and allow free keys per the schema.
 */

import { fuzzyFilter } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { type CompatField, compatFieldFor, compatFieldsForApi, validateJsonCompatValue } from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { DictPane } from "./dictionary.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { renderInfoLine, renderKeyValueLine, renderPlainLine, ValueEditor } from "./value-row.ts";

function compatObject(handle: ModelHandle): Record<string, unknown> {
	const compat = handle.read().compat;
	return typeof compat === "object" && compat !== null && !Array.isArray(compat)
		? (compat as Record<string, unknown>)
		: {};
}

function scalarText(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value) ?? String(value);
}

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

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
	}

	private entries(): [string, unknown][] {
		return Object.entries(compatObject(this.model));
	}

	private effectiveApi(): string | undefined {
		return this.host.effectiveApi(this.model.read());
	}

	/** Entry rows plus the trailing "+ Add Entry" action. */
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
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: mode.key,
					valueText: "choose a value",
					active: true,
					paneFocused: this.focused,
					width,
				}),
			);
			for (const [index, option] of mode.options.entries()) {
				lines.push(
					renderPlainLine(theme, option, { active: index === mode.index, paneFocused: this.focused, width }),
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
		const start = Math.max(0, Math.min(this.index - 5, entries.length + 1 - 10));
		for (const [offset, [key, value]] of entries.slice(start, start + 10).entries()) {
			const rowIndex = start + offset;
			const active = rowIndex === this.index;
			const field = api ? compatFieldFor(api, key) : undefined;
			const editing = this.mode.type === "editValue" && this.mode.key === key ? this.mode.editor : undefined;
			const note = field ? undefined : `· not used by ${api ?? "this api"}`;
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: key,
					valueText: value === undefined ? "unset" : scalarText(value),
					active,
					paneFocused: this.focused,
					editing,
					note,
					width,
				}),
			);
		}
		if (entries.length < start + 10)
			lines.push(
				renderPlainLine(theme, "+ Add Entry", {
					active: this.index === entries.length && this.mode.type === "list",
					paneFocused: this.focused,
					width,
				}),
			);
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
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
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.rowCount() - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % this.rowCount();
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
			this.host.mutate(() => this.model.setField(["compat", key], DELETE));
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
				this.mode = { type: "chooseValue", key, options: field.options, index: 0 };
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
				const shapeError = validateJsonCompatValue(key, text);
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
		this.host.mutate(() => this.model.setField(["compat", key], value));
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
				rawKeyHint("↑↓", "move"),
				keyHint("tui.select.confirm", "set"),
				keyHint("tui.select.cancel", "cancel"),
			].join("  ");
		return [
			keyHint("tui.select.confirm", "edit"),
			keyHint("app.list.toggle", "toggle"),
			keyHint("app.provider.removeEntry", "remove"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
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

	private readonly host: EditorHost;
	private readonly api: string;
	private readonly taken: ReadonlySet<string>;
	private readonly onPick: (key: string) => void;

	constructor(host: EditorHost, api: string, taken: ReadonlySet<string>, onPick: (key: string) => void) {
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
		const lines: string[] = [this.editor.renderLine(width)];
		const candidates = this.candidates();
		if (candidates.length === 0) lines.push(renderInfoLine(theme, "No remaining known fields.", width));
		const start = Math.max(0, Math.min(this.index - 5, candidates.length - 10));
		for (const [offset, field] of candidates.slice(start, start + 10).entries()) {
			lines.push(
				renderPlainLine(theme, field.key, {
					active: start + offset === this.index,
					paneFocused: this.focused,
					note: field.note ? `· ${field.kind} — ${truncate(field.note, 30)}` : `· ${field.kind}`,
					width,
				}),
			);
		}
		return lines;
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
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "choose"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
