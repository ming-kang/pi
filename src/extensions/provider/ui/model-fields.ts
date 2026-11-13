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
import { formatTokens, plural, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { AdvancedPane, advancedNote, MODEL_ADVANCED_FIELDS } from "./advanced.ts";
import { BuiltinCandidatesPane } from "./builtin-data.ts";
import { CompatPane } from "./compat.ts";
import { InlineEdit, moveSelection } from "./controls.ts";
import { CostPane, createReasoningPane, InputTypesPane, ModelSpecificApiPane } from "./model-options.ts";
import type { EditorPane, ModelFieldsHost, ModelHandle } from "./pane.ts";
import { ThinkingMapPane } from "./thinking-map.ts";
import {
	fieldOrigin,
	isPrintableInput,
	renderInfoLine,
	renderKeyValueLine,
	type ScrollWindowInfo,
} from "./value-row.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

type FieldRow =
	| { kind: "text"; key: "id" | "name" }
	| { kind: "reasoning" }
	| { kind: "subpage"; key: "thinkingLevelMap" | "input" | "cost" | "compat" }
	| { kind: "number"; key: "contextWindow" | "maxTokens" }
	| { kind: "builtin" }
	| { kind: "advanced" }
	| { kind: "modelApi" }
	| { kind: "deleteModel" }
	| { kind: "resetOverride" };

const COST_RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** A $/M rate without float noise or trailing zeros; "-" when unset. */
function formatRate(rate: number | undefined): string {
	return rate === undefined ? "-" : String(Number(rate.toFixed(6)));
}

/** A token count as typed: 500000, 500_000, 500,000, 500k, or 1.5m (k = 1000, as catalog sizes are written). */
export function parseTokenCount(raw: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(raw.trim().replace(/[_,]/g, ""));
	if (!match) return undefined;
	const scale = { "": 1, k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase() as "" | "k" | "m"];
	const value = Number(match[1]) * scale;
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

type FieldKey = "name" | "reasoning" | "thinkingLevelMap" | "input" | "cost" | "contextWindow" | "maxTokens" | "compat";

export class ModelFieldsPane implements EditorPane {
	private readonly rows: FieldRow[];
	private index = 0;
	private readonly edit: InlineEdit<FieldRow>;
	private focused = false;
	private renaming = false;
	private disposed = false;

	private readonly host: ModelFieldsHost;
	private readonly model: ModelHandle;
	constructor(host: ModelFieldsHost, model: ModelHandle) {
		this.host = host;
		this.edit = new InlineEdit(() => host.refresh());
		this.model = model;

		// An override edits a catalog model in place: its id is fixed and its api/baseUrl cannot be overridden.
		const rows: FieldRow[] = model.kind === "override" ? [] : [{ kind: "text", key: "id" }];
		rows.push(
			{ kind: "text", key: "name" },
			{ kind: "reasoning" },
			{ kind: "subpage", key: "thinkingLevelMap" },
			{ kind: "subpage", key: "input" },
			{ kind: "subpage", key: "cost" },
			{ kind: "number", key: "contextWindow" },
			{ kind: "number", key: "maxTokens" },
			{ kind: "subpage", key: "compat" },
			{ kind: "advanced" },
		);
		if (model.kind === "draft") rows.push({ kind: "modelApi" });
		else if (model.kind === "custom") rows.push({ kind: "builtin" }, { kind: "modelApi" }, { kind: "deleteModel" });
		else rows.push({ kind: "resetOverride" });
		this.rows = rows;
	}

	/** Enter id editing immediately (used right after + Add Model). */
	startEditingId(): void {
		this.index = 0;
		this.beginEdit("overwrite");
	}

	/** A draft with no fields set is safe to abandon without asking. */
	private draftEmpty(): boolean {
		return this.model.kind === "draft" && Object.keys(this.model.read()).length === 0;
	}

	/** A pushed page (a catalog model opened from Built-in models) keeps its name in the title. */
	get heading(): string {
		const fields = this.model.read();
		return fields.name ?? fields.id ?? "New model";
	}

	/** Display of a set value: a model with built-in values dims what it inherits and marks what it overrides. */
	private tagged(key: FieldKey, text: string): { valueText: string; unset?: boolean; note?: string } {
		return { valueText: text, ...fieldOrigin(this.model, [key]) };
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read();
		const lines: string[] = [];
		const api = this.host.effectiveApi(current);
		const provider = this.host.store.getProvider(this.host.providerId);
		const apiSource = this.model.base()
			? " · built-in"
			: current.api
				? " · model"
				: provider?.api
					? " · provider"
					: "";
		lines.push(
			renderInfoLine(
				theme,
				api ? `api: ${api}${apiSource}` : "api: none resolved — see Model-specific API below",
				width,
			),
		);
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			lines.push(this.renderRow(row, current, active, width));
		}
		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
		if (this.renaming) lines.push(renderInfoLine(theme, "Saving model id…", width));
		if (this.model.base())
			lines.push(renderInfoLine(theme, "Dim values are built in; clearing restores them.", width));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The effective-api header stays pinned above, errors/progress below.
		return {
			top: 1,
			bottom: (this.edit.error ? 1 : 0) + (this.renaming ? 1 : 0) + (this.model.base() ? 1 : 0),
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
		const editing = this.edit.editor(row);
		switch (row.kind) {
			case "text": {
				const value = current[row.key];
				const unsetText = row.key === "id" ? "required" : `falls back to id`;
				const shown =
					row.key === "name" && value
						? this.tagged("name", value)
						: { valueText: value ?? `not set (${unsetText})`, unset: !value };
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					...shown,
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
					...(value === undefined
						? { valueText: "false (default)", unset: true }
						: this.tagged("reasoning", String(value))),
					active,
					paneFocused: this.focused,
					width,
				});
			}
			case "subpage": {
				const summary = this.subpageSummary(row.key, current);
				const shown = summary.unset ? { valueText: summary.text, unset: true } : this.tagged(row.key, summary.text);
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					...shown,
					active,
					paneFocused: this.focused,
					width,
				});
			}
			case "number": {
				const value = current[row.key];
				const fallback = row.key === "contextWindow" ? DEFAULT_CONTEXT_WINDOW : DEFAULT_MAX_TOKENS;
				// The exact count is what is saved; the short form is how a long number gets read.
				const shown =
					value === undefined
						? { valueText: `${fallback} (default)`, unset: true }
						: this.tagged(row.key, String(value));
				const short = value !== undefined && value >= 100_000 ? `· ${formatTokens(value)}` : undefined;
				return renderKeyValueLine(theme, {
					keyLabel: row.key,
					...shown,
					note: [short, shown.note].filter(Boolean).join(" ") || undefined,
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
					valueText: "Use built-in data",
					active,
					paneFocused: this.focused,
					note: id ? `· ${count} ${plural(count, "candidate")}` : "· set id first",
					width,
				});
			}
			case "advanced": {
				return renderKeyValueLine(theme, {
					valueText: "Advanced",
					active,
					paneFocused: this.focused,
					note: advancedNote(this.model, MODEL_ADVANCED_FIELDS),
					width,
				});
			}
			case "modelApi":
				return renderKeyValueLine(theme, {
					valueText: "Model-specific API",
					active,
					paneFocused: this.focused,
					note: `· ${this.modelApiSummary(current)}`,
					width,
				});
			case "deleteModel":
				return renderKeyValueLine(theme, {
					valueText: "Delete model",
					active,
					paneFocused: this.focused,
					width,
				});
			case "resetOverride": {
				const count = Object.keys(this.model.own()).length;
				return renderKeyValueLine(theme, {
					valueText: "Reset to built-in",
					active,
					paneFocused: this.focused,
					note: count > 0 ? `· ${count} overridden` : "· nothing overridden",
					width,
				});
			}
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
					? { text: `${count} ${plural(count, "level")}`, unset: false }
					: { text: "default", unset: true };
			}
			case "input":
				return current.input
					? { text: `[${current.input.join(", ")}]`, unset: false }
					: { text: "[text] (default)", unset: true };
			case "cost": {
				const cost = current.cost;
				if (!cost) return { text: "- / - / - / -", unset: true };
				// Rates only; the sub-page names them and holds the tiers.
				return { text: COST_RATES.map((rate) => formatRate(cost[rate])).join(" / "), unset: false };
			}
			case "compat": {
				const compat = current.compat;
				const count = compat ? Object.keys(compat).length : 0;
				if (count > 0) return { text: `${count} ${plural(count, "entry")}`, unset: false };
				const inherited = this.host.store.getProvider(this.host.providerId)?.compat;
				const inheritedCount = inherited ? Object.keys(inherited).length : 0;
				return inheritedCount > 0
					? { text: `${inheritedCount} ${plural(inheritedCount, "entry")} · provider`, unset: true }
					: { text: "none", unset: true };
			}
		}
	}

	handleInput(data: string): void {
		if (this.renaming || this.disposed) return;
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const next = moveSelection(kb, data, this.index, this.rows.length);
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.model.kind !== "draft") {
				this.host.popPane();
				return;
			}
			// Esc on a draft abandons it; a draft with fields asks first.
			if (this.draftEmpty()) {
				this.host.discardModelDraft();
				return;
			}
			const label = this.model.read().name ?? this.model.read().id ?? "New model";
			this.host.confirm(`Discard the new model "${label}"? Its fields are not saved.`, "Discard model", () =>
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
		this.model.setField(["reasoning"], current !== true);
	}

	private enterRow(): void {
		const row = this.rows[this.index]!;
		switch (row.kind) {
			case "text":
			case "number":
				this.beginEdit("tweak");
				return;
			case "reasoning":
				this.host.pushPane(createReasoningPane(this.host, this.model));
				return;
			case "subpage":
				this.pushSubpage(row.key);
				return;
			case "advanced":
				this.host.pushPane(new AdvancedPane(this.host, this.model, MODEL_ADVANCED_FIELDS));
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
			case "resetOverride": {
				const model = this.model;
				if (model.kind !== "override" || Object.keys(model.own()).length === 0) return;
				this.host.confirm(
					`Remove every override of "${model.read().id}"? The built-in values return.`,
					"Reset to built-in",
					() => {
						model.reset();
						this.host.popPane();
					},
				);
				return;
			}
			case "deleteModel": {
				const id = this.model.read().id;
				if (id) this.host.removeModel(id);
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
		this.edit.begin(
			row,
			current === undefined ? "" : String(current),
			mode,
			this.focused,
			(value) => this.commitText(row, value),
			firstData,
			{
				onCancel: () => {
					// Cancelling the edit of an untouched draft abandons the draft outright.
					if (this.draftEmpty()) this.host.discardModelDraft();
				},
			},
		);
	}

	private commitText(
		row: FieldRow & { kind: "text" | "number" },
		raw: string,
	): string | undefined | Promise<string | undefined> {
		const value = raw.trim();
		if (row.key === "id") {
			if (!value) return "id is required and cannot be empty.";
			if (this.model.kind === "draft") {
				this.model.setField(["id"], value);
				return this.host.commitModelDraft();
			}
			const current = this.model.read().id;
			if (!current || this.model.kind !== "custom") return "Missing current id.";
			if (value === current) return undefined;
			if (this.host.isCurrentModel(current)) {
				return "The current model's id cannot be renamed; switch models with /model first.";
			}
			if (this.host.store.getModel(this.host.providerId, value)) {
				return `Model "${value}" already exists.`;
			}
			this.renaming = true;
			this.host.refresh();
			return this.model.rename(value).finally(() => {
				this.renaming = false;
			});
		}
		if (row.key === "name") {
			this.model.setField(["name"], value === "" ? DELETE : value);
			return undefined;
		}
		// Numeric rows: empty clears the override; otherwise a finite positive integer.
		if (value === "") {
			this.model.setField([row.key], DELETE);
			return undefined;
		}
		const parsed = parseTokenCount(value);
		if (parsed === undefined) {
			return `${row.key} must be a positive whole number of tokens, e.g. 500000 or 500k.`;
		}
		this.model.setField([row.key], parsed);
		return undefined;
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
		this.edit.setFocused(focused);
	}

	isEditing(): boolean {
		return this.edit.editing || this.renaming;
	}

	dispose(): void {
		this.disposed = true;
		this.edit.dispose();
	}

	/** Only the keys the selected row answers to, so the footer fits 80 columns and never lies. */
	hints(): string {
		if (this.edit.editing)
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		const row = this.rows[this.index];
		const back = keyHint("tui.select.cancel", this.model.kind === "draft" ? "discard" : "back");
		switch (row?.kind) {
			case "text":
			case "number":
				return [rawKeyHint("type", "overwrite"), keyHint("tui.select.confirm", "edit"), back].join("  ");
			case "reasoning":
				return [keyHint("app.list.toggle", "toggle"), keyHint("tui.select.confirm", "open"), back].join("  ");
			case "resetOverride":
				return [keyHint("tui.select.confirm", "reset"), back].join("  ");
			case "deleteModel":
				return [keyHint("tui.select.confirm", "delete"), back].join("  ");
			default:
				return [keyHint("tui.select.confirm", "open"), back].join("  ");
		}
	}
}
