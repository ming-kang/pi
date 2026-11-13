/**
 * Compat pane: entries are `Key: Value` rows whose Key comes from the known
 * field catalog of the model's effective API (picker, no arbitrary top-level
 * keys). Open dictionaries (chatTemplateKwargs/chatTemplateArgs) nest one
 * level deeper and allow free keys per the schema.
 */

import "../keybindings.ts";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { type CompatField, compatFieldFor, compatFieldsForApi, validateJsonCompatValue } from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { ChoicePane, FilterListPane, InlineEdit, moveSelection } from "./controls.ts";
import { compatObject, DictPane, scalarText } from "./dictionary.ts";
import type { CompatFields, EditorPane, PaneHost, ProviderPaneHost } from "./pane.ts";
import { renderInfoLine, renderKeyValueLine, renderPlainLine, type ScrollWindowInfo } from "./value-row.ts";

export class CompatPane implements EditorPane {
	readonly crumb = "compat";
	private index = 0;
	private readonly edit: InlineEdit<string>;
	private focused = false;

	private readonly host: ProviderPaneHost;
	private readonly model: CompatFields;
	constructor(host: ProviderPaneHost, model: CompatFields) {
		this.host = host;
		this.model = model;
		this.edit = new InlineEdit(() => host.refresh());
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
		const known = api ? compatFieldsForApi(api) : [];
		const entries = this.entries();
		const editingKey = this.edit.activeKey;
		if (editingKey !== undefined && !entries.some(([key]) => key === editingKey))
			entries.push([editingKey, undefined]);
		if (known.length === 0 && entries.length === 0) {
			lines.push(renderInfoLine(theme, `No compat fields are known for ${api ?? "this api"}.`, width));
		}
		// All entries render; the editor's fixed window scrolls around scrollWindow().
		for (const [rowIndex, [key, value]] of entries.entries()) {
			const active = rowIndex === this.index;
			const field = api ? compatFieldFor(api, key) : undefined;
			const note = field ? undefined : `· not used by ${api ?? "this api"}`;
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: key,
					valueText: value === undefined ? "not set" : scalarText(value),
					active,
					paneFocused: this.focused,
					editing: this.edit.editor(key),
					note,
					width,
				}),
			);
		}
		lines.push(
			renderPlainLine(theme, "+ Add entry", {
				active: this.index === entries.length && !this.edit.editing,
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
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
		return { top: 1, bottom: (this.edit.error ? 1 : 0) + (this.selectedNote() ? 2 : 0), cursor: 1 + this.index };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const next = moveSelection(kb, data, this.index, this.rowCount());
		if (next !== undefined) {
			this.index = next;
			this.edit.error = undefined;
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
			this.edit.error = undefined;
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
				this.pushChoicePane(key, field.options, field.note);
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
				this.pushChoicePane(key, ["true", "false"], field.note, true);
				return;
			case "enum":
				this.pushChoicePane(key, field.options, field.note);
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
		this.edit.begin(key, current === undefined ? "" : String(current), "tweak", this.focused, (raw) => {
			const parsed = Number(raw.trim());
			if (!Number.isFinite(parsed)) return `${key} must be a number.`;
			this.writeValue(key, parsed);
			return undefined;
		});
	}

	private beginJsonEdit(key: string, current: unknown): void {
		this.edit.begin(key, current === undefined ? "" : JSON.stringify(current), "tweak", this.focused, (raw) => {
			const text = raw.trim();
			if (!text) {
				this.writeValue(key, DELETE);
				return undefined;
			}
			const shapeError = validateJsonCompatValue(this.effectiveApi(), key, text);
			if (shapeError) return shapeError;
			this.writeValue(key, JSON.parse(text));
			return undefined;
		});
	}

	private pushChoicePane(key: string, options: readonly string[], note: string | undefined, isBoolean = false): void {
		const current = () => {
			const val = compatObject(this.model)[key];
			return val === undefined ? undefined : String(val);
		};
		this.host.pushPane(
			new ChoicePane<string>(this.host, `compat · ${key}`, {
				header: note ? `${key} · ${note}` : key,
				current: () => current() ?? "",
				initial: current() ?? options[0],
				choices: () => options.map((option) => ({ label: option, value: option })),
				choose: (option) => {
					this.writeValue(key, isBoolean ? option === "true" : option);
					return undefined;
				},
			}),
		);
	}

	private writeValue(key: string, value: unknown): void {
		this.model.setField(["compat", key], value);
	}

	private fail(message: string): void {
		this.edit.error = message;
		this.host.refresh();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.edit.setFocused(focused);
	}

	isEditing(): boolean {
		return this.edit.editing;
	}

	hints(): string {
		if (this.edit.editing)
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
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

export class CompatKeyPickerPane extends FilterListPane<CompatField> {
	constructor(host: PaneHost, api: string, taken: ReadonlySet<string>, onPick: (key: string) => void) {
		super(host, {
			crumb: "compat · new entry",
			items: (query) => {
				const available = compatFieldsForApi(api).filter((field) => !taken.has(field.key));
				const trimmed = query.trim();
				return trimmed ? fuzzyFilter(available, trimmed, (field) => `${field.key} ${field.note ?? ""}`) : available;
			},
			renderItem: (field, { active, focused, width }) =>
				renderPlainLine(host.theme, field.key, {
					active,
					paneFocused: focused,
					// The description is what tells similar keys apart; the row cuts at the pane edge, not at 30 characters.
					note: field.note ? `· ${field.note}` : `· ${field.kind}`,
					width,
				}),
			emptyMessage: "No remaining known fields.",
			confirmVerb: "choose",
			onConfirm: (field) => {
				host.popPane();
				onPick(field.key);
			},
		});
	}
}
