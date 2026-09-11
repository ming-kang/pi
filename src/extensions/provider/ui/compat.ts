/**
 * Compat pane: entries are `Key: Value` rows whose Key comes from the known
 * field catalog of the model's effective API (picker, no arbitrary top-level
 * keys). Open dictionaries (chatTemplateKwargs/chatTemplateArgs) nest one
 * level deeper and allow free keys per the schema.
 */

import { fuzzyFilter } from "@earendil-works/pi-tui";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import {
	type CompatField,
	compatFieldFor,
	compatFieldsForApi,
	validateChatTemplateKwarg,
	validateJsonCompatValue,
} from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
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
		const known = api ? compatFieldsForApi(api) : [];
		const entries = this.entries();
		if (known.length === 0 && entries.length === 0) {
			lines.push(renderInfoLine(theme, `No compat fields are known for ${api ?? "this api"}.`, width));
		}
		for (const [rowIndex, [key, value]] of entries.entries()) {
			const active = rowIndex === this.index && this.mode.type === "list";
			const field = api ? compatFieldFor(api, key) : undefined;
			const editing = this.mode.type === "editValue" && this.mode.key === key ? this.mode.editor : undefined;
			const note = field ? undefined : `· not used by ${api ?? "this api"}`;
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: key,
					valueText: scalarText(value),
					active,
					paneFocused: this.focused,
					editing,
					note,
					width,
				}),
			);
			if (this.mode.type === "chooseValue" && this.mode.key === key) {
				for (const [choiceIndex, option] of this.mode.options.entries()) {
					lines.push(
						renderPlainLine(theme, option, {
							active: choiceIndex === this.mode.index,
							paneFocused: this.focused,
							width,
						}),
					);
				}
			}
		}
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
				this.mode = { type: "chooseValue", key, options: field.options ?? [], index: 0 };
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
				this.mode = { type: "chooseValue", key, options: field.options ?? [], index: 0 };
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
		const editor = new ValueEditor(this.host.keybindings, {
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
		const editor = new ValueEditor(this.host.keybindings, {
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

		this.editor = new ValueEditor(host.keybindings, {
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
		for (const [rowIndex, field] of candidates.slice(0, 10).entries()) {
			lines.push(
				renderPlainLine(theme, field.key, {
					active: rowIndex === this.index,
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

// -------------------------------------------------------------------------
// Open-dictionary entries (chatTemplateKwargs / chatTemplateArgs)
// -------------------------------------------------------------------------

type DictValueKind = "string" | "number" | "boolean" | "null" | "$var";
const DICT_VALUE_KINDS: readonly DictValueKind[] = ["string", "number", "boolean", "null", "$var"];
const VAR_OPTIONS = ["thinking.enabled", "thinking.effort"] as const;

type DictMode =
	| { type: "list" }
	| { type: "keyEdit"; editor: ValueEditor }
	| { type: "kindPick"; key: string; index: number }
	| { type: "valueEdit"; key: string; kind: "string" | "number"; editor: ValueEditor }
	| { type: "boolPick"; key: string; index: number }
	| { type: "varPick"; key: string; index: number }
	| { type: "omitPick"; key: string; $var: (typeof VAR_OPTIONS)[number]; index: number };

export class DictPane implements EditorPane {
	readonly crumb: string;
	private index = 0;
	private mode: DictMode = { type: "list" };
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	private readonly dictKey: string;
	constructor(host: EditorHost, model: ModelHandle, dictKey: string) {
		this.host = host;
		this.model = model;
		this.dictKey = dictKey;

		this.crumb = `compat · ${dictKey}`;
	}

	private dict(): Record<string, unknown> {
		const value = compatObject(this.model)[this.dictKey];
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	}

	private entries(): [string, unknown][] {
		return Object.entries(this.dict());
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [
			renderInfoLine(theme, `free-form keys; values: string · number · boolean · null · $var`, width),
		];
		const entries = this.entries();
		for (const [rowIndex, [key, value]] of entries.entries()) {
			const active = rowIndex === this.index && this.mode.type === "list";
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: key,
					valueText: scalarText(value),
					active,
					paneFocused: this.focused,
					width,
				}),
			);
		}
		lines.push(
			renderPlainLine(theme, "+ Add Entry", {
				active: this.index === entries.length && this.mode.type === "list",
				paneFocused: this.focused,
				width,
			}),
		);
		lines.push(...this.renderMode(width));
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	private renderMode(width: number): string[] {
		const theme = this.host.theme;
		switch (this.mode.type) {
			case "keyEdit":
				return [renderInfoLine(theme, "new key:", width), this.mode.editor.renderLine(width)];
			case "kindPick": {
				const mode = this.mode;
				return [
					renderInfoLine(theme, `${mode.key} · value kind`, width),
					...DICT_VALUE_KINDS.map((kind, kindIndex) =>
						renderPlainLine(theme, kind, {
							active: kindIndex === mode.index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			}
			case "valueEdit":
				return [
					renderInfoLine(theme, `${this.mode.key} · ${this.mode.kind}`, width),
					this.mode.editor.renderLine(width),
				];
			case "boolPick":
				return [
					renderInfoLine(theme, `${this.mode.key} · boolean`, width),
					...["true", "false"].map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === (this.mode as { index: number }).index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			case "varPick":
				return [
					renderInfoLine(theme, `${this.mode.key} · $var`, width),
					...VAR_OPTIONS.map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === (this.mode as { index: number }).index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			case "omitPick":
				return [
					renderInfoLine(theme, `${this.mode.key} · omitWhenOff`, width),
					...["unset", "true", "false"].map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === (this.mode as { index: number }).index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			default:
				return [];
		}
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		switch (this.mode.type) {
			case "keyEdit":
			case "valueEdit":
				if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
				this.mode.editor.handleInput(data);
				this.host.refresh();
				return;
			case "kindPick":
				this.handlePick(data, DICT_VALUE_KINDS.length, (index) => {
					const key = (this.mode as { key: string }).key;
					const kind = DICT_VALUE_KINDS[index]!;
					this.startValueForKind(key, kind);
				});
				return;
			case "boolPick":
				this.handlePick(data, 2, (index) => {
					const key = (this.mode as { key: string }).key;
					this.mode = { type: "list" };
					this.writeEntry(key, index === 0);
				});
				return;
			case "varPick":
				this.handlePick(data, VAR_OPTIONS.length, (index) => {
					const key = (this.mode as { key: string }).key;
					this.mode = { type: "omitPick", key, $var: VAR_OPTIONS[index]!, index: 0 };
					this.host.refresh();
				});
				return;
			case "omitPick":
				this.handlePick(data, 3, (index) => {
					const mode = this.mode as { key: string; $var: (typeof VAR_OPTIONS)[number] };
					this.mode = { type: "list" };
					this.writeEntry(
						mode.key,
						index === 0 ? { $var: mode.$var } : { $var: mode.$var, omitWhenOff: index === 1 },
					);
				});
				return;
			case "list":
				this.handleList(data);
				return;
		}
	}

	private handlePick(data: string, count: number, choose: (index: number) => void): void {
		const kb = this.host.keybindings;
		const index = (this.mode as { index: number }).index;
		if (kb.matches(data, "tui.select.up")) {
			(this.mode as { index: number }).index = index === 0 ? count - 1 : index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			(this.mode as { index: number }).index = (index + 1) % count;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.mode = { type: "list" };
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) choose(index);
	}

	private handleList(data: string): void {
		const kb = this.host.keybindings;
		const rowCount = this.entries().length + 1;
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? rowCount - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % rowCount;
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
			this.host.mutate(() => this.model.setField(["compat", this.dictKey, entry[0]], DELETE));
			this.index = Math.max(0, Math.min(this.index, this.entries().length - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const entry = this.entries()[this.index];
			if (!entry) {
				// + Add Entry: key first, then the value flow.
				const editor = new ValueEditor(this.host.keybindings, {
					onCommit: (raw) => {
						const key = raw.trim();
						if (!key) {
							this.error = "Key must be non-empty.";
							return this.host.refresh();
						}
						if (key in this.dict()) {
							this.error = `"${key}" already exists.`;
							return this.host.refresh();
						}
						this.error = undefined;
						this.mode = { type: "kindPick", key, index: 0 };
						this.host.refresh();
					},
					onCancel: () => {
						this.mode = { type: "list" };
						this.error = undefined;
						this.host.refresh();
					},
				});
				editor.focused = this.focused;
				this.mode = { type: "keyEdit", editor };
				this.host.refresh();
				return;
			}
			const [key, value] = entry;
			if (typeof value === "boolean") {
				this.writeEntry(key, !value);
				return;
			}
			if (value === null) return; // null entries: remove + re-add to change
			if (typeof value === "object") {
				const record = value as Record<string, unknown>;
				if (record.$var === "thinking.enabled" || record.$var === "thinking.effort") {
					this.mode = {
						type: "omitPick",
						key,
						$var: record.$var,
						index: record.omitWhenOff === undefined ? 0 : record.omitWhenOff ? 1 : 2,
					};
					this.host.refresh();
					return;
				}
				return; // unexpected object: remove + re-add
			}
			const kind: "string" | "number" = typeof value === "number" ? "number" : "string";
			const editor = new ValueEditor(this.host.keybindings, {
				onCommit: (raw) => this.commitScalar(key, kind, raw),
				onCancel: () => {
					this.mode = { type: "list" };
					this.error = undefined;
					this.host.refresh();
				},
			});
			editor.beginTweak(String(value));
			editor.focused = this.focused;
			this.mode = { type: "valueEdit", key, kind, editor };
			this.host.refresh();
			return;
		}
	}

	private startValueForKind(key: string, kind: DictValueKind): void {
		switch (kind) {
			case "string":
			case "number": {
				const editor = new ValueEditor(this.host.keybindings, {
					onCommit: (raw) => this.commitScalar(key, kind, raw),
					onCancel: () => {
						this.mode = { type: "list" };
						this.error = undefined;
						this.host.refresh();
					},
				});
				editor.focused = this.focused;
				this.mode = { type: "valueEdit", key, kind, editor };
				this.host.refresh();
				return;
			}
			case "boolean":
				this.mode = { type: "boolPick", key, index: 0 };
				this.host.refresh();
				return;
			case "null":
				this.mode = { type: "list" };
				this.writeEntry(key, null);
				return;
			case "$var":
				this.mode = { type: "varPick", key, index: 0 };
				this.host.refresh();
				return;
		}
	}

	private commitScalar(key: string, kind: "string" | "number", raw: string): void {
		let value: string | number = raw;
		if (kind === "number") {
			const parsed = Number(raw.trim());
			if (!Number.isFinite(parsed)) {
				this.error = `${key} must be a number.`;
				this.host.refresh();
				return;
			}
			value = parsed;
		}
		const invalid = validateChatTemplateKwarg(value);
		if (invalid) {
			this.error = invalid;
			this.host.refresh();
			return;
		}
		this.error = undefined;
		this.mode = { type: "list" };
		this.writeEntry(key, value);
	}

	private writeEntry(key: string, value: unknown): void {
		const invalid = validateChatTemplateKwarg(value);
		if (invalid) {
			this.error = invalid;
			this.host.refresh();
			return;
		}
		this.host.mutate(() => this.model.setField(["compat", this.dictKey, key], value));
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.mode.type === "keyEdit" || this.mode.type === "valueEdit") this.mode.editor.focused = focused;
	}

	isEditing(): boolean {
		return this.mode.type === "keyEdit" || this.mode.type === "valueEdit";
	}

	hints(): string {
		switch (this.mode.type) {
			case "keyEdit":
			case "valueEdit":
				return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
			case "list":
				return [
					keyHint("tui.select.confirm", "edit / add"),
					keyHint("app.provider.removeEntry", "remove"),
					keyHint("tui.select.cancel", "back"),
				].join("  ");
			default:
				return [
					rawKeyHint("↑↓", "move"),
					keyHint("tui.select.confirm", "choose"),
					keyHint("tui.select.cancel", "cancel"),
				].join("  ");
		}
	}
}
