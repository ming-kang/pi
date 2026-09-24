/**
 * Model field pane (right column for a selected model) plus its nested
 * sub-panes: thinkingLevelMap, input modalities, and cost. All edits flow
 * through the ModelHandle — drafts mutate memory, persisted models queue
 * store ops that save immediately.
 */

import "../keybindings.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { matchBuiltinModels } from "../catalog.ts";
import { plural, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { BuiltinCandidatesPane } from "./builtin-data.ts";
import { CompatPane } from "./compat.ts";
import { CostPane, InputTypesPane, ModelSpecificApiPane, ReasoningPane } from "./model-options.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { ThinkingMapPane } from "./thinking-map.ts";
import {
	isPrintableInput,
	renderInfoLine,
	renderKeyValueLine,
	type ScrollWindowInfo,
	ValueEditor,
} from "./value-row.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

type FieldRow =
	| { kind: "text"; key: "id" | "name" }
	| { kind: "reasoning" }
	| { kind: "subpage"; key: "thinkingLevelMap" | "input" | "cost" | "compat" }
	| { kind: "number"; key: "contextWindow" | "maxTokens" }
	| { kind: "builtin" }
	| { kind: "modelApi" }
	| { kind: "deleteModel" };

export class ModelFieldsPane implements EditorPane {
	private readonly rows: FieldRow[];
	private index = 0;
	private editing: ValueEditor | undefined;
	private editingRow: FieldRow | undefined;
	private error: string | undefined;
	private focused = false;
	private renaming = false;
	private disposed = false;

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
		if (model.isDraft) rows.push({ kind: "modelApi" });
		else rows.push({ kind: "builtin" }, { kind: "modelApi" }, { kind: "deleteModel" });
		this.rows = rows;
	}

	/** Enter id editing immediately (used right after + Add Model). */
	startEditingId(): void {
		this.index = 0;
		this.beginEdit("overwrite");
	}

	/** A draft with no fields set is safe to abandon without asking. */
	private draftEmpty(): boolean {
		return this.model.isDraft && Object.keys(this.model.read()).length === 0;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read();
		const lines: string[] = [];
		const api = this.host.effectiveApi(current);
		lines.push(
			renderInfoLine(
				theme,
				api ? `api: ${api}${current.api ? " (model)" : ""}` : "api: none resolved — see Model-Specific API below",
				width,
			),
		);
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			lines.push(this.renderRow(row, current, active, width));
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		if (this.renaming) lines.push(renderInfoLine(theme, "Saving model id…", width));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The effective-api header stays pinned above, errors/progress below.
		return {
			top: 1,
			bottom: (this.error ? 1 : 0) + (this.renaming ? 1 : 0),
			cursor: 1 + this.index,
		};
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
					valueText: value ?? `not set (${unsetText})`,
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
					valueText: summary.text,
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
					valueText: "Use Built-in Data",
					active,
					paneFocused: this.focused,
					note: id ? `· ${count} ${plural(count, "candidate")}` : "· set id first",
					width,
				});
			}
			case "modelApi":
				return renderKeyValueLine(theme, {
					valueText: "Model-Specific API",
					active,
					paneFocused: this.focused,
					note: `· ${this.modelApiSummary(current)}`,
					width,
				});
			case "deleteModel":
				return renderKeyValueLine(theme, {
					valueText: "Delete Model",
					active,
					paneFocused: this.focused,
					width,
				});
		}
	}

	/** Which connection fields this model overrides, or where they come from when it overrides nothing. */
	private modelApiSummary(current: Partial<ModelsJsonModel> & { id?: string }): string {
		const overrides = [current.baseUrl ? "baseUrl" : "", current.api ? "API Type" : ""].filter(Boolean);
		if (overrides.length > 0) return overrides.join(" + ");
		const provider = this.host.store.getProvider(this.host.providerId);
		if (provider?.api || provider?.baseUrl) return "provider defaults";
		if (this.host.effectiveApi(current) || this.host.effectiveBaseUrl(current)) return "built-in defaults";
		return "not set";
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
					? { text: `${count} ${plural(count, "mapping")}`, unset: false }
					: { text: "default", unset: true };
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
				if (count > 0) return { text: `${count} ${count === 1 ? "entry" : "entries"}`, unset: false };
				const inherited = this.host.store.getProvider(this.host.providerId)?.compat;
				const inheritedCount = inherited ? Object.keys(inherited).length : 0;
				return inheritedCount > 0
					? { text: `${inheritedCount} from provider`, unset: true }
					: { text: "none", unset: true };
			}
		}
	}

	handleInput(data: string): void {
		if (this.renaming || this.disposed) return;
		const kb = this.host.keybindings;
		if (this.editing) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.editing.handleInput(data);
			this.host.refresh();
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
			if (!this.model.isDraft) {
				this.host.popPane();
				return;
			}
			// Esc on a draft abandons it; a draft with fields asks first.
			if (this.draftEmpty()) {
				this.host.discardModelDraft();
				return;
			}
			const label = this.model.read().name ?? this.model.read().id ?? "New Model";
			this.host.confirm(`Discard the new model "${label}"? Its fields are not saved.`, "Discard Model", () =>
				this.host.discardModelDraft(),
			);
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
				this.host.pushPane(new ReasoningPane(this.host, this.model));
				return;
			case "subpage":
				this.pushSubpage(row.key);
				return;
			case "modelApi":
				this.host.pushPane(new ModelSpecificApiPane(this.host, this.model));
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
		const editor = new ValueEditor({
			onCommit: (value) => this.commitText(row, value),
			onCancel: () => {
				this.editing = undefined;
				this.editingRow = undefined;
				this.error = undefined;
				// Cancelling the edit of an untouched draft abandons the draft outright.
				if (this.draftEmpty()) {
					this.host.discardModelDraft();
					return;
				}
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
			this.renaming = true;
			this.host.refresh();
			void this.model.rename(value).then(
				(error) => {
					this.renaming = false;
					if (!this.disposed) finish(error);
				},
				(error: unknown) => {
					this.renaming = false;
					if (!this.disposed) finish(error instanceof Error ? error.message : String(error));
				},
			);
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

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editing) this.editing.focused = focused;
	}

	isEditing(): boolean {
		return this.editing !== undefined || this.renaming;
	}

	dispose(): void {
		this.disposed = true;
	}

	hints(): string {
		if (this.editing) return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit / open"),
			keyHint("app.list.toggle", "toggle"),
			keyHint("tui.select.cancel", this.model.isDraft ? "discard" : "back"),
		].join("  ");
	}
}
