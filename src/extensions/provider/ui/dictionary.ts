/** Open chat-template dictionaries, with typed value-entry states. */

import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { THINKING_VARIABLES, validateChatTemplateKwarg } from "../compat-fields.ts";
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

type DictValueKind = "string" | "number" | "boolean" | "null" | "$var";
const DICT_VALUE_KINDS: readonly DictValueKind[] = ["string", "number", "boolean", "null", "$var"];
const VAR_OPTIONS = THINKING_VARIABLES;

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
		if (this.mode.type !== "list") {
			lines.push(...this.renderMode(width));
			if (this.error) lines.push(renderInfoLine(theme, this.error, width));
			return lines;
		}
		const entries = this.entries();
		const start = Math.max(0, Math.min(this.index - 5, entries.length + 1 - 10));
		for (const [offset, [key, value]] of entries.slice(start, start + 10).entries()) {
			const active = start + offset === this.index;
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

	private renderMode(width: number): string[] {
		const theme = this.host.theme;
		const mode = this.mode;
		switch (mode.type) {
			case "keyEdit":
				return [renderInfoLine(theme, "new key:", width), mode.editor.renderLine(width)];
			case "kindPick": {
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
					renderInfoLine(theme, `${mode.key} · ${mode.kind}`, width),
					renderKeyValueLine(theme, {
						keyLabel: mode.key,
						active: true,
						paneFocused: this.focused,
						editing: mode.editor,
						width,
					}),
				];
			case "boolPick":
				return [
					renderInfoLine(theme, `${mode.key} · boolean`, width),
					...["true", "false"].map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === mode.index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			case "varPick":
				return [
					renderInfoLine(theme, `${mode.key} · $var`, width),
					...VAR_OPTIONS.map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === mode.index,
							paneFocused: this.focused,
							width,
						}),
					),
				];
			case "omitPick":
				return [
					renderInfoLine(theme, `${mode.key} · omitWhenOff`, width),
					...["unset", "true", "false"].map((option, optionIndex) =>
						renderPlainLine(theme, option, {
							active: optionIndex === mode.index,
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
		const mode = this.mode;
		switch (mode.type) {
			case "keyEdit":
			case "valueEdit":
				if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
				mode.editor.handleInput(data);
				this.host.refresh();
				return;
			case "kindPick":
				this.handlePick(data, mode, DICT_VALUE_KINDS.length, (index) => {
					const key = mode.key;
					const kind = DICT_VALUE_KINDS[index]!;
					this.startValueForKind(key, kind);
				});
				return;
			case "boolPick":
				this.handlePick(data, mode, 2, (index) => {
					const key = mode.key;
					this.mode = { type: "list" };
					this.writeEntry(key, index === 0);
				});
				return;
			case "varPick":
				this.handlePick(data, mode, VAR_OPTIONS.length, (index) => {
					const key = mode.key;
					this.mode = { type: "omitPick", key, $var: VAR_OPTIONS[index]!, index: 0 };
					this.host.refresh();
				});
				return;
			case "omitPick":
				this.handlePick(data, mode, 3, (index) => {
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

	private handlePick(
		data: string,
		mode: Extract<DictMode, { index: number }>,
		count: number,
		choose: (index: number) => void,
	): void {
		const kb = this.host.keybindings;
		const index = mode.index;
		if (kb.matches(data, "tui.select.up")) {
			mode.index = index === 0 ? count - 1 : index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			mode.index = (index + 1) % count;
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
				if (
					record.$var === "thinking.enabled" ||
					record.$var === "thinking.effort" ||
					record.$var === "thinking.budget"
				) {
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

	private startValueForKind(key: string, kind: DictValueKind): void {
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
