/**
 * Model field pane (right column for a selected model) plus its nested
 * sub-panes: thinkingLevelMap, input modalities, and cost. All edits flow
 * through the ModelHandle — drafts mutate memory, persisted models queue
 * store ops that save immediately.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { matchBuiltinModels } from "../catalog.ts";
import { INPUT_TYPES, type InputType, THINKING_LEVELS, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { BuiltinCandidatesPane } from "./builtin-data.ts";
import { CompatPane } from "./compat.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { isPrintableInput, renderInfoLine, renderKeyValueLine, renderPlainLine, ValueEditor } from "./value-row.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

type FieldRow =
	| { kind: "text"; key: "id" | "name" }
	| { kind: "reasoning" }
	| { kind: "subpage"; key: "thinkingLevelMap" | "input" | "cost" | "compat" }
	| { kind: "number"; key: "contextWindow" | "maxTokens" }
	| { kind: "builtin" }
	| { kind: "deleteModel" };

export class ModelFieldsPane implements EditorPane {
	readonly crumb: string;
	private readonly rows: FieldRow[];
	private index = 0;
	private editing: ValueEditor | undefined;
	private editingRow: FieldRow | undefined;
	private error: string | undefined;
	private focused = false;
	private reasoningChoice: number | undefined; // 0 true · 1 false · 2 unset

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;

		const rows: FieldRow[] = [
			{ kind: "text", key: "id" },
			{ kind: "text", key: "name" },
			{ kind: "reasoning" },
			{ kind: "subpage", key: "thinkingLevelMap" },
			{ kind: "subpage", key: "input" },
			{ kind: "subpage", key: "cost" },
			{ kind: "number", key: "contextWindow" },
			{ kind: "number", key: "maxTokens" },
			{ kind: "subpage", key: "compat" },
		];
		if (!model.isDraft) rows.push({ kind: "builtin" }, { kind: "deleteModel" });
		this.rows = rows;
		const current = model.read();
		this.crumb = current.name ?? current.id ?? "New Model";
	}

	/** Enter id editing immediately (used right after + Add Model). */
	startEditingId(): void {
		this.index = 0;
		this.beginEdit("overwrite");
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read();
		const lines: string[] = [];
		const api = this.host.effectiveApi(current);
		lines.push(
			renderInfoLine(
				theme,
				api ? `api: ${api}${current.api ? " (model-level)" : ""}` : "api: unresolved — set API Type",
				width,
			),
		);
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			lines.push(this.renderRow(row, current, active, width));
		}
		if (this.reasoningChoice !== undefined) {
			for (const [choiceIndex, label] of ["true", "false", "unset (default: false)"].entries()) {
				lines.push(
					renderPlainLine(theme, label, {
						active: choiceIndex === this.reasoningChoice,
						paneFocused: this.focused,
						dim: choiceIndex === 2,
						width,
					}),
				);
			}
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	private renderRow(
		row: FieldRow,
		current: Partial<ModelsJsonModel> & { id?: string },
		active: boolean,
		width: number,
	): string {
		const theme = this.host.theme;
		const editing = this.editingRow === row ? this.editing : undefined;
		switch (row.kind) {
			case "text": {
				const value = current[row.key];
				const unsetText = row.key === "id" ? "required" : `falls back to id`;
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					valueText: value ?? `unset (${unsetText})`,
					unset: !value,
					active,
					paneFocused: this.focused,
					editing,
					width,
				});
			}
			case "reasoning": {
				const value = current.reasoning;
				return renderKeyValueLine(theme, {
					keyLabel: "reasoning",
					valueText: value === undefined ? "false (default)" : String(value),
					unset: value === undefined,
					active,
					paneFocused: this.focused,
					width,
				});
			}
			case "subpage": {
				const summary = this.subpageSummary(row.key, current);
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					valueText: `${summary.text} →`,
					unset: summary.unset,
					active,
					paneFocused: this.focused,
					width,
				});
			}
			case "number": {
				const value = current[row.key];
				const fallback = row.key === "contextWindow" ? DEFAULT_CONTEXT_WINDOW : DEFAULT_MAX_TOKENS;
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					valueText: value === undefined ? `${fallback} (default)` : String(value),
					unset: value === undefined,
					active,
					paneFocused: this.focused,
					editing,
					width,
				});
			}
			case "builtin": {
				const id = current.id;
				const count = id ? matchBuiltinModels(id, this.host.effectiveApi(current)).length : 0;
				return renderKeyValueLine(theme, {
					valueText: "Use Built-in Data…",
					active,
					paneFocused: this.focused,
					note: id ? `· ${count} candidate${count === 1 ? "" : "s"}` : "· set id first",
					width,
				});
			}
			case "deleteModel":
				return renderKeyValueLine(theme, {
					valueText: "Delete Model",
					active,
					paneFocused: this.focused,
					width,
				});
		}
	}

	private subpageSummary(
		key: "thinkingLevelMap" | "input" | "cost" | "compat",
		current: Partial<ModelsJsonModel>,
	): { text: string; unset: boolean } {
		switch (key) {
			case "thinkingLevelMap": {
				const map = current.thinkingLevelMap;
				const count = map ? Object.keys(map).length : 0;
				return count > 0
					? { text: `${count} mapping${count === 1 ? "" : "s"}`, unset: false }
					: { text: "inherit", unset: true };
			}
			case "input":
				return current.input
					? { text: `[${current.input.join(", ")}]`, unset: false }
					: { text: "[text] (default)", unset: true };
			case "cost": {
				const cost = current.cost;
				if (!cost) return { text: "all 0 (default)", unset: true };
				return { text: `$${cost.input} / $${cost.output} in/out`, unset: false };
			}
			case "compat": {
				const compat = current.compat;
				const count = compat ? Object.keys(compat).length : 0;
				return count > 0
					? { text: `${count} ${count === 1 ? "entry" : "entries"}`, unset: false }
					: { text: "inherit", unset: true };
			}
		}
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.editing) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.editing.handleInput(data);
			this.host.refresh();
			return;
		}
		if (this.reasoningChoice !== undefined) {
			this.handleReasoningChoice(data);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? this.rows.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % this.rows.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "app.list.toggle")) {
			this.toggleRow();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.enterRow();
			return;
		}
		if (isPrintableInput(data)) {
			this.overwriteRow(data);
			return;
		}
	}

	private toggleRow(): void {
		const row = this.rows[this.index]!;
		if (row.kind !== "reasoning") return; // Space on other rows falls to overwrite handling below
		const current = this.model.read().reasoning;
		this.host.mutate(() => this.model.setField(["reasoning"], current !== true));
	}

	private enterRow(): void {
		const row = this.rows[this.index]!;
		switch (row.kind) {
			case "text":
			case "number":
				this.beginEdit("tweak");
				return;
			case "reasoning":
				this.reasoningChoice =
					this.model.read().reasoning === true ? 0 : this.model.read().reasoning === false ? 1 : 2;
				this.host.refresh();
				return;
			case "subpage":
				this.pushSubpage(row.key);
				return;
			case "builtin": {
				const id = this.model.read().id;
				if (!id) {
					this.host.notify("Set the model id first.", "warning");
					return;
				}
				this.host.pushPane(new BuiltinCandidatesPane(this.host, this.model));
				return;
			}
			case "deleteModel": {
				const id = this.model.read().id;
				if (!id) return;
				if (this.host.isCurrentModel(id)) {
					this.host.notify("The current model cannot be deleted; switch models with /model first.", "error");
					return;
				}
				this.host.confirm(`Delete model "${id}" from ${this.host.providerId}?`, "Delete Model", () => {
					this.host.mutate(() => this.host.store.removeModel(this.host.providerId, id));
					this.host.onModelRemoved(id);
				});
				return;
			}
		}
	}

	private overwriteRow(data: string): void {
		const row = this.rows[this.index]!;
		if (row.kind === "text" || row.kind === "number") {
			this.beginEdit("overwrite", data);
			return;
		}
	}

	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const row = this.rows[this.index]!;
		if (row.kind !== "text" && row.kind !== "number") return;
		const current = this.model.read()[row.key];
		const editor = new ValueEditor(this.host.keybindings, {
			onCommit: (value) => this.commitText(row, value),
			onCancel: () => {
				this.editing = undefined;
				this.editingRow = undefined;
				this.error = undefined;
				this.host.refresh();
			},
		});
		this.editing = editor;
		this.editingRow = row;
		editor.focused = this.focused;
		if (mode === "overwrite") editor.beginOverwrite(firstData);
		else editor.beginTweak(current === undefined ? "" : String(current));
		this.host.refresh();
	}

	private commitText(row: FieldRow & { kind: "text" | "number" }, raw: string): void {
		const value = raw.trim();
		const finish = (error?: string) => {
			this.error = error;
			if (error) {
				this.host.refresh();
				return;
			}
			this.editing = undefined;
			this.editingRow = undefined;
			this.host.refresh();
		};
		if (row.key === "id") {
			if (!value) {
				finish("id is required and cannot be empty.");
				return;
			}
			if (this.model.isDraft) {
				this.model.setField(["id"], value);
				finish(this.host.commitModelDraft());
				return;
			}
			const current = this.model.read().id;
			if (!current) {
				finish("Missing current id.");
				return;
			}
			if (value === current) {
				finish();
				return;
			}
			if (this.host.isCurrentModel(current)) {
				finish("The current model's id cannot be renamed; switch models with /model first.");
				return;
			}
			if (this.host.store.getModel(this.host.providerId, value)) {
				finish(`Model "${value}" already exists.`);
				return;
			}
			this.host.mutate(() => this.model.setField(["id"], value));
			finish();
			return;
		}
		if (row.key === "name") {
			this.host.mutate(() => this.model.setField(["name"], value === "" ? DELETE : value));
			finish();
			return;
		}
		// Numeric rows: empty clears the override; otherwise a finite positive integer.
		if (value === "") {
			this.host.mutate(() => this.model.setField([row.key], DELETE));
			finish();
			return;
		}
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed <= 0) {
			finish(`${row.key} must be a positive integer.`);
			return;
		}
		this.host.mutate(() => this.model.setField([row.key], parsed));
		finish();
		return;
	}

	private pushSubpage(key: "thinkingLevelMap" | "input" | "cost" | "compat"): void {
		switch (key) {
			case "thinkingLevelMap":
				this.host.pushPane(new ThinkingMapPane(this.host, this.model));
				return;
			case "input":
				this.host.pushPane(new InputTypesPane(this.host, this.model));
				return;
			case "cost":
				this.host.pushPane(new CostPane(this.host, this.model));
				return;
			case "compat":
				this.host.pushPane(new CompatPane(this.host, this.model));
				return;
		}
	}

	private handleReasoningChoice(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.reasoningChoice = this.reasoningChoice === 0 ? 2 : (this.reasoningChoice ?? 0) - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.reasoningChoice = ((this.reasoningChoice ?? 0) + 1) % 3;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.reasoningChoice = undefined;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const choice = this.reasoningChoice ?? 0;
			this.reasoningChoice = undefined;
			this.host.mutate(() =>
				this.model.setField(["reasoning"], choice === 0 ? true : choice === 1 ? false : DELETE),
			);
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editing) this.editing.focused = focused;
	}

	isEditing(): boolean {
		return this.editing !== undefined;
	}

	hints(): string {
		if (this.editing) return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		if (this.reasoningChoice !== undefined)
			return [
				rawKeyHint("↑↓", "move"),
				keyHint("tui.select.confirm", "set"),
				keyHint("tui.select.cancel", "cancel"),
			].join("  ");
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit / enter"),
			keyHint("app.list.toggle", "toggle"),
			keyHint("app.provider.switchPaneLeft", "focus left"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

// -------------------------------------------------------------------------
// thinkingLevelMap
// -------------------------------------------------------------------------

type ThinkingMapMode =
	| { type: "levels" }
	| { type: "choice"; level: ModelThinkingLevel; index: number }
	| { type: "target"; level: ModelThinkingLevel };

export class ThinkingMapPane implements EditorPane {
	readonly crumb = "thinkingLevelMap";
	private mode: ThinkingMapMode = { type: "levels" };
	private index = 0;
	private editor: ValueEditor | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
	}

	private map(): Partial<Record<ModelThinkingLevel, string | null>> {
		return this.model.read().thinkingLevelMap ?? {};
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [];
		if (this.model.read().reasoning !== true) {
			lines.push(
				renderInfoLine(theme, "reasoning is not true — the map is stored but currently has no effect.", width),
			);
		}
		if (this.mode.type === "levels") {
			for (const [rowIndex, level] of THINKING_LEVELS.entries()) {
				const value = this.map()[level];
				const status = value === undefined ? "inherit" : value === null ? "null (hidden)" : value;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: level,
						valueText: status,
						unset: value === undefined,
						active: rowIndex === this.index,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		} else if (this.mode.type === "choice") {
			lines.push(renderInfoLine(theme, `${this.mode.level} · mapping`, width));
			for (const [choiceIndex, label] of [
				"String target (provider effort)",
				"Hidden (null)",
				"Inherit (remove key)",
			].entries()) {
				lines.push(
					renderPlainLine(theme, label, {
						active: choiceIndex === this.mode.index,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		} else {
			lines.push(renderInfoLine(theme, `${this.mode.level} · non-empty provider effort`, width));
			lines.push(this.editor?.renderLine(width) ?? "");
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.mode.type === "target") {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.editor?.handleInput(data);
			this.host.refresh();
			return;
		}
		if (this.mode.type === "choice") {
			if (kb.matches(data, "tui.select.up")) {
				this.mode = { ...this.mode, index: this.mode.index === 0 ? 2 : this.mode.index - 1 };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.mode = { ...this.mode, index: (this.mode.index + 1) % 3 };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.mode = { type: "levels" };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const { level, index } = this.mode;
				if (index === 0) {
					const editor = new ValueEditor(this.host.keybindings, {
						onCommit: (value) => {
							const target = value.trim();
							if (!target) {
								this.error = "A string target must be non-empty; use Hidden for null.";
								return this.host.refresh();
							}
							this.error = undefined;
							this.mode = { type: "levels" };
							this.editor = undefined;
							this.host.mutate(() => this.model.setField(["thinkingLevelMap", level], target));
						},
						onCancel: () => {
							this.editor = undefined;
							this.mode = { type: "levels" };
							this.host.refresh();
						},
					});
					this.editor = editor;
					editor.focused = this.focused;
					const existing = this.map()[level];
					if (typeof existing === "string") editor.beginTweak(existing);
					this.mode = { type: "target", level };
					this.host.refresh();
					return;
				}
				this.mode = { type: "levels" };
				this.host.mutate(() => this.model.setField(["thinkingLevelMap", level], index === 1 ? null : DELETE));
				return;
			}
			return;
		}
		// levels
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? THINKING_LEVELS.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % THINKING_LEVELS.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.mode = { type: "choice", level: THINKING_LEVELS[this.index]!, index: 0 };
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editor) this.editor.focused = focused && this.mode.type === "target";
	}

	isEditing(): boolean {
		return this.mode.type === "target";
	}

	hints(): string {
		if (this.mode.type === "target")
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "back")].join("  ");
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", this.mode.type === "choice" ? "set" : "edit"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

// -------------------------------------------------------------------------
// input modalities
// -------------------------------------------------------------------------

export class InputTypesPane implements EditorPane {
	readonly crumb = "input";
	private index = 0;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
	}

	private selected(): Set<string> {
		return new Set(this.model.read().input ?? ["text"]);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const selected = this.selected();
		const lines = INPUT_TYPES.map((type, rowIndex) =>
			renderPlainLine(theme, type, {
				checked: selected.has(type),
				active: rowIndex === this.index,
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.model.read().input === undefined) {
			lines.push(renderInfoLine(theme, "unset — the runtime default is [text].", width));
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? INPUT_TYPES.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % INPUT_TYPES.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "app.list.toggle")) {
			const type: InputType = INPUT_TYPES[this.index]!;
			const selected = this.selected();
			if (selected.has(type)) {
				if (selected.size === 1) {
					this.error = "At least one input type must stay selected.";
					this.host.refresh();
					return;
				}
				selected.delete(type);
			} else {
				selected.add(type);
			}
			this.error = undefined;
			const next = INPUT_TYPES.filter((entry) => selected.has(entry));
			this.host.mutate(() => this.model.setField(["input"], [...next]));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			keyHint("app.list.toggle", "toggle"),
			keyHint("tui.select.confirm", "done"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

// -------------------------------------------------------------------------
// cost
// -------------------------------------------------------------------------

const COST_RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;
type CostRate = (typeof COST_RATES)[number];

export class CostPane implements EditorPane {
	readonly crumb = "cost";
	private index = 0;
	private editing: ValueEditor | undefined;
	private editingRate: CostRate | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
	}

	private cost(): Record<CostRate, number> | undefined {
		const cost = this.model.read().cost;
		if (!cost) return undefined;
		return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const cost = this.cost();
		const lines: string[] = [];
		for (const [rowIndex, rate] of COST_RATES.entries()) {
			const value = cost?.[rate];
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: rate,
					valueText: value === undefined ? "0 (default)" : `$${value} / M tokens`,
					unset: value === undefined,
					active: rowIndex === this.index,
					paneFocused: this.focused,
					editing: this.editingRate === rate ? this.editing : undefined,
					width,
				}),
			);
		}
		const tiers = this.model.read().cost?.tiers;
		if (tiers && tiers.length > 0) {
			lines.push(renderInfoLine(theme, `tiers: ${tiers.length} (read-only; kept as-is)`, width));
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.editing) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.editing.handleInput(data);
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? COST_RATES.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % COST_RATES.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.beginEdit("tweak");
			return;
		}
		if (isPrintableInput(data)) {
			this.beginEdit("overwrite", data);
			return;
		}
	}

	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const rate = COST_RATES[this.index]!;
		const current = this.cost()?.[rate];
		const editor = new ValueEditor(this.host.keybindings, {
			onCommit: (value) => this.commit(rate, value),
			onCancel: () => {
				this.editing = undefined;
				this.editingRate = undefined;
				this.error = undefined;
				this.host.refresh();
			},
		});
		this.editing = editor;
		this.editingRate = rate;
		editor.focused = this.focused;
		if (mode === "overwrite") editor.beginOverwrite(firstData);
		else editor.beginTweak(current === undefined ? "" : String(current));
		this.host.refresh();
	}

	private commit(rate: CostRate, raw: string): void {
		const value = raw.trim();
		const parsed = value === "" ? 0 : Number(value);
		if (!Number.isFinite(parsed) || parsed < 0) {
			this.error = "cost rates must be finite non-negative numbers.";
			this.host.refresh();
			return;
		}
		this.error = undefined;
		this.editing = undefined;
		this.editingRate = undefined;
		// A cost object must stay complete: first edit materializes the other rates as 0; tiers are preserved.
		const current = this.cost() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const tiers = this.model.read().cost?.tiers;
		const next = { ...current, [rate]: parsed, ...(tiers ? { tiers } : {}) };
		this.host.mutate(() => this.model.setField(["cost"], next));
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editing) this.editing.focused = focused;
	}

	isEditing(): boolean {
		return this.editing !== undefined;
	}

	hints(): string {
		if (this.editing) return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
