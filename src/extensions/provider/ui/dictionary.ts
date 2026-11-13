/** Open chat-template dictionaries, with typed value-entry states. */

import "../keybindings.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { THINKING_VARIABLES, validateChatTemplateKwarg } from "../compat-fields.ts";
import { truncate } from "../constants.ts";
import { isPlainObject } from "../json-fields.ts";
import { DELETE } from "../store.ts";
import { ChoicePane, moveSelection } from "./controls.ts";
import type { CompatFields, EditorPane, PaneHost } from "./pane.ts";
import {
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	type ScrollWindowInfo,
	ValueEditor,
} from "./value-row.ts";

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

type DictMode =
	| { type: "list" }
	| { type: "keyEdit"; editor: ValueEditor }
	| { type: "valueEdit"; key: string; kind: "string" | "number"; editor: ValueEditor };

export class DictPane implements EditorPane {
	readonly crumb: string;
	private index = 0;
	private mode: DictMode = { type: "list" };
	private error: string | undefined;
	private focused = false;

	private readonly host: PaneHost;
	private readonly model: CompatFields;
	private readonly dictKey: string;
	constructor(host: PaneHost, model: CompatFields, dictKey: string) {
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
		if (this.mode.type !== "list") {
			lines.push(...this.renderMode(width));
			if (this.error) lines.push(renderInfoLine(theme, this.error, width));
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
				active: this.index === entries.length && this.mode.type === "list",
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The format header pins above; errors pin below. Entry flows are short
		// enough to fit, so only the list mode reports a meaningful cursor.
		if (this.mode.type !== "list") return { top: 1, bottom: this.error ? 1 : 0 };
		return { top: 1, bottom: this.error ? 1 : 0, cursor: 1 + this.index };
	}

	private renderMode(width: number): string[] {
		const theme = this.host.theme;
		const mode = this.mode;
		switch (mode.type) {
			case "keyEdit":
				return [
					renderKeyValueLine(theme, {
						keyLabel: "New key",
						active: true,
						paneFocused: this.focused,
						editing: mode.editor,
						width,
					}),
				];
			case "valueEdit":
				return [
					renderInfoLine(theme, `${mode.key} · ${mode.kind}`, width),
					renderKeyValueLine(theme, {
						keyLabel: mode.key,
						active: true,
						paneFocused: this.focused,
						editing: mode.editor,
						width,
					}),
				];
			default:
				return [];
		}
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const mode = this.mode;
		switch (mode.type) {
			case "keyEdit":
			case "valueEdit":
				if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
				mode.editor.handleInput(data);
				this.host.refresh();
				return;
			case "list":
				this.handleList(data);
				return;
		}
	}

	private handleList(data: string): void {
		const kb = this.host.keybindings;
		const rowCount = this.entries().length + 1;
		const next = moveSelection(kb, data, this.index, rowCount);
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
			this.model.setField(["compat", this.dictKey, entry[0]], DELETE);
			this.index = Math.max(0, Math.min(this.index, this.entries().length - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const entry = this.entries()[this.index];
			if (!entry) {
				// + Add entry: key first, then the value flow.
				const editor = new ValueEditor({
					onCommit: (raw) => {
						const key = raw.trim();
						if (!key) {
							this.error = "Key must be non-empty.";
							return this.host.refresh();
						}
						if (Object.hasOwn(this.dict(), key)) {
							this.error = `"${key}" already exists.`;
							return this.host.refresh();
						}
						this.error = undefined;
						this.mode = { type: "list" };
						this.pushKindPicker(key);
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
			const editor = new ValueEditor({
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

	private startValueForKind(key: string, kind: Exclude<DictValueKind, "null">): void {
		switch (kind) {
			case "string":
			case "number": {
				const editor = new ValueEditor({
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
				current: () => undefined as unknown as DictValueKind,
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
			new ChoicePane<boolean | undefined>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · boolean`,
				current: () => undefined,
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
			new ChoicePane<(typeof VAR_OPTIONS)[number] | undefined>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · $var`,
				current: () => undefined,
				initial: VAR_OPTIONS[0],
				choices: () => VAR_OPTIONS.map((option) => ({ label: option, value: option })),
				choose: () => undefined,
				afterChoose: ($var) => {
					if ($var) this.pushOmitPicker(key, $var);
				},
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
			new ChoicePane<OmitChoice | undefined>(this.host, `compat · ${this.dictKey} · ${key}`, {
				header: `${key} · omitWhenOff`,
				current: () => currentOmit,
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
		const error = this.writeEntry(key, value);
		if (error) {
			this.error = error;
			this.host.refresh();
			return;
		}
		this.error = undefined;
		this.mode = { type: "list" };
		this.host.refresh();
	}

	private writeEntry(key: string, value: unknown): string | undefined {
		const invalid = validateChatTemplateKwarg(value);
		if (invalid) return invalid;
		this.model.setField(["compat", this.dictKey, key], value);
		return undefined;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.mode.type === "keyEdit" || this.mode.type === "valueEdit") this.mode.editor.focused = focused;
	}

	isEditing(): boolean {
		return this.mode.type === "keyEdit" || this.mode.type === "valueEdit";
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
