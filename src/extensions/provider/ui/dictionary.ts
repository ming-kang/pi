/** Open chat-template dictionaries, with typed value-entry states. */

import "../keybindings.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { THINKING_VARIABLES, validateChatTemplateKwarg } from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { isPlainObject } from "../json-fields.ts";
import { DELETE } from "../store.ts";
import { ChoicePane, InlineEdit, moveSelection } from "./controls.ts";
import type { CompatFields, EditorPane, PaneHost } from "./pane.ts";
import { renderInfoLine, renderKeyValueLine, renderPlainLine, type ScrollWindowInfo } from "./value-row.ts";

/** The handle's compat object; empty when unset. */
export function compatObject(handle: CompatFields): Record<string, unknown> {
	const compat = handle.read().compat;
	return isPlainObject(compat) ? compat : {};
}

export function scalarText(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value) ?? String(value);
}

type DictValueKind = "string" | "number" | "boolean" | "null" | "$var";
const DICT_VALUE_KINDS: readonly DictValueKind[] = ["string", "number", "boolean", "null", "$var"];
const VAR_OPTIONS = THINKING_VARIABLES;

const NEW_KEY = Symbol("NEW_KEY");
type DictEditKey = typeof NEW_KEY | string;

export class DictPane implements EditorPane {
	readonly crumb: string;
	private index = 0;
	private readonly edit: InlineEdit<DictEditKey>;
	private editingKind: "string" | "number" | undefined;
	private focused = false;

	private readonly host: PaneHost;
	private readonly model: CompatFields;
	private readonly dictKey: string;
	constructor(host: PaneHost, model: CompatFields, dictKey: string) {
		this.host = host;
		this.model = model;
		this.dictKey = dictKey;
		this.edit = new InlineEdit(() => host.refresh());

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
		const activeKey = this.edit.activeKey;
		if (activeKey !== undefined) {
			if (activeKey === NEW_KEY) {
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "New key",
						active: true,
						paneFocused: this.focused,
						editing: this.edit.editor(NEW_KEY),
						width,
					}),
				);
			} else {
				lines.push(
					renderInfoLine(theme, `${activeKey} · ${this.editingKind ?? "string"}`, width),
					renderKeyValueLine(theme, {
						keyLabel: activeKey,
						active: true,
						paneFocused: this.focused,
						editing: this.edit.editor(activeKey),
						width,
					}),
				);
			}
			if (this.edit.error) lines.push(renderInfoLine(theme, this.edit.error, width));
			return lines;
		}
		const entries = this.entries();
		// All entries render; the editor's fixed window scrolls around scrollWindow().
		for (const [rowIndex, [key, value]] of entries.entries()) {
			const active = rowIndex === this.index;
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
			renderPlainLine(theme, "+ Add entry", {
				active: this.index === entries.length && !this.edit.editing,
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The format header pins above; errors pin below. Entry flows are short
		// enough to fit, so only the list mode reports a meaningful cursor.
		if (this.edit.editing) return { top: 1, bottom: this.edit.error ? 1 : 0 };
		return { top: 1, bottom: this.edit.error ? 1 : 0, cursor: 1 + this.index };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const rowCount = this.entries().length + 1;
		const next = moveSelection(kb, data, this.index, rowCount);
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
			this.edit.error = undefined;
			this.model.setField(["compat", this.dictKey, entry[0]], DELETE);
			this.index = Math.max(0, Math.min(this.index, this.entries().length - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const entry = this.entries()[this.index];
			if (!entry) {
				// + Add entry: key first, then the value flow.
				let acceptedKey: string | undefined;
				this.edit.begin(
					NEW_KEY,
					"",
					"overwrite",
					this.focused,
					(raw) => {
						const key = raw.trim();
						if (!key) return "Key must be non-empty.";
						if (Object.hasOwn(this.dict(), key)) return `"${key}" already exists.`;
						acceptedKey = key;
						return undefined;
					},
					undefined,
					{
						onDone: () => {
							if (acceptedKey) this.pushKindPicker(acceptedKey);
						},
					},
				);
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
				if (
					record.$var === "thinking.enabled" ||
					record.$var === "thinking.effort" ||
					record.$var === "thinking.budget"
				) {
					const currentOmit = record.omitWhenOff === undefined ? "default" : record.omitWhenOff ? "true" : "false";
					this.pushOmitPicker(key, record.$var, currentOmit);
					return;
				}
				return; // unexpected object: remove + re-add
			}
			const kind: "string" | "number" = typeof value === "number" ? "number" : "string";
			this.beginScalarEdit(key, kind, String(value));
		}
	}

	private beginScalarEdit(key: string, kind: "string" | "number", current?: string): void {
		this.editingKind = kind;
		this.edit.begin(
			key,
			current ?? "",
			current === undefined ? "overwrite" : "tweak",
			this.focused,
			(raw) => this.commitScalar(key, kind, raw),
			undefined,
			{
				onDone: () => {
					this.editingKind = undefined;
				},
				onCancel: () => {
					this.editingKind = undefined;
				},
			},
		);
	}

	private startValueForKind(key: string, kind: Exclude<DictValueKind, "null">): void {
		switch (kind) {
			case "string":
			case "number":
				this.beginScalarEdit(key, kind);
				return;
			case "boolean":
				this.pushBoolPicker(key);
				return;
			case "$var":
				this.pushVarPicker(key);
				return;
		}
	}

	private pushKindPicker(key: string): void {
		this.host.pushPane(
			new ChoicePane<DictValueKind>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · value kind`,
				initial: DICT_VALUE_KINDS[0],
				choices: () => DICT_VALUE_KINDS.map((kind) => ({ label: kind, value: kind })),
				choose: (kind) => (kind === "null" ? this.writeEntry(key, null) : undefined),
				afterChoose: (kind) => {
					if (kind !== "null") this.startValueForKind(key, kind);
				},
			}),
		);
	}

	private pushBoolPicker(key: string): void {
		this.host.pushPane(
			new ChoicePane<boolean>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · boolean`,
				initial: true,
				choices: () => [
					{ label: "true", value: true },
					{ label: "false", value: false },
				],
				choose: (value) => this.writeEntry(key, value),
			}),
		);
	}

	private pushVarPicker(key: string): void {
		this.host.pushPane(
			new ChoicePane<(typeof VAR_OPTIONS)[number]>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · $var`,
				initial: VAR_OPTIONS[0],
				choices: () => VAR_OPTIONS.map((option) => ({ label: option, value: option })),
				choose: () => undefined,
				afterChoose: ($var) => this.pushOmitPicker(key, $var),
			}),
		);
	}

	private pushOmitPicker(
		key: string,
		$var: (typeof VAR_OPTIONS)[number],
		currentOmit?: "default" | "true" | "false",
	): void {
		type OmitChoice = "default" | "true" | "false";
		this.host.pushPane(
			new ChoicePane<OmitChoice>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · omitWhenOff`,
				current: currentOmit === undefined ? undefined : () => currentOmit,
				initial: currentOmit ?? "default",
				choices: () => [
					{ label: "default", value: "default" },
					{ label: "true", value: "true" },
					{ label: "false", value: "false" },
				],
				choose: (choice) =>
					this.writeEntry(key, choice === "default" ? { $var } : { $var, omitWhenOff: choice === "true" }),
			}),
		);
	}

	private commitScalar(key: string, kind: "string" | "number", raw: string): string | undefined {
		let value: string | number = raw;
		if (kind === "number") {
			const parsed = Number(raw.trim());
			if (!Number.isFinite(parsed)) return `${key} must be a number.`;
			value = parsed;
		}
		return this.writeEntry(key, value);
	}

	private writeEntry(key: string, value: unknown): string | undefined {
		const invalid = validateChatTemplateKwarg(value);
		if (invalid) return invalid;
		this.model.setField(["compat", this.dictKey, key], value);
		return undefined;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.edit.setFocused(focused);
	}

	isEditing(): boolean {
		return this.edit.editing;
	}

	hints(): string {
		if (this.isEditing())
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		return [
			keyHint("tui.select.confirm", "edit / add"),
			keyHint("app.provider.removeEntry", "remove"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
