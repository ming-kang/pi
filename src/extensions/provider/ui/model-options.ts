/** Scalar model settings: reasoning, input modalities, cost rates, and the model-specific API override. */

import "../keybindings.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults } from "../catalog.ts";
import { API_TYPES, INPUT_TYPES, type InputType, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { ChoicePane, InlineEdit, moveSelection } from "./controls.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { baseUrlHint, validateBaseUrlValue } from "./provider-fields.ts";
import { isPrintableInput, renderInfoLine, renderKeyValueLine, renderPlainLine } from "./value-row.ts";

// -------------------------------------------------------------------------
// reasoning
// -------------------------------------------------------------------------

const REASONING_OPTIONS = [
	{ label: "true", value: true },
	{ label: "false", value: false },
	{ label: "default (false)", value: undefined },
] as const;

/** Radio sub-page for reasoning — consistent with the other nested model settings. */
export function createReasoningPane(host: EditorHost, model: ModelHandle): EditorPane {
	return new ChoicePane<boolean | undefined>(host, "reasoning", {
		current: () => model.read().reasoning,
		choices: () => REASONING_OPTIONS.map((option) => ({ ...option, dim: option.value === undefined })),
		choose: (value) => {
			model.setField(["reasoning"], value === undefined ? DELETE : value);
			return undefined;
		},
	});
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
			lines.push(renderInfoLine(theme, "Not set — the runtime default is [text].", width));
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const next = moveSelection(kb, data, this.index, INPUT_TYPES.length);
		if (next !== undefined) {
			this.index = next;
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
			this.model.setField(["input"], [...next]);
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
	private readonly edit: InlineEdit<CostRate>;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.edit = new InlineEdit(() => host.refresh());
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
					editing: this.edit.editor(rate),
					width,
				}),
			);
		}
		const tiers = this.model.read().cost?.tiers;
		if (tiers && tiers.length > 0) {
			lines.push(renderInfoLine(theme, `tiers: ${tiers.length} (read-only; kept as-is)`, width));
		}
		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const next = moveSelection(kb, data, this.index, COST_RATES.length);
		if (next !== undefined) {
			this.index = next;
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
		this.edit.begin(
			rate,
			current === undefined ? "" : String(current),
			mode,
			this.focused,
			(value) => this.commit(rate, value),
			firstData,
		);
	}

	private commit(rate: CostRate, raw: string): string | undefined {
		const value = raw.trim();
		const parsed = value === "" ? 0 : Number(value);
		if (!Number.isFinite(parsed) || parsed < 0) {
			return "cost rates must be finite non-negative numbers.";
		}
		// A cost object must stay complete: first edit materializes the other rates as 0; tiers are preserved.
		if (this.model.read().cost) this.model.setField(["cost", rate], parsed);
		else this.model.setField(["cost"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [rate]: parsed });
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
		if (this.edit.editing)
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

// -------------------------------------------------------------------------
// Model-Specific API
// -------------------------------------------------------------------------

/**
 * Model-level baseUrl / API Type overrides. Unset rows show the inherited
 * provider or built-in value dimmed; typing on a row (or editing the shown
 * value) writes an override, clearing it returns to inheritance.
 */
export class ModelSpecificApiPane implements EditorPane {
	readonly crumb = "Model-Specific API";
	private readonly rows = ["baseUrl", "apiType"] as const;
	private index = 0;
	private readonly edit: InlineEdit<"baseUrl">;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.edit = new InlineEdit(() => host.refresh());
		this.model = model;
	}

	/** Where an unset model field resolves from; undefined when nothing resolves it. */
	private inherited(key: "api" | "baseUrl"): { value: string; via: "provider" | "built-in" } | undefined {
		const provider = this.host.store.getProvider(this.host.providerId);
		const providerValue = key === "api" ? provider?.api : provider?.baseUrl;
		if (providerValue) return { value: providerValue, via: "provider" };
		const current = this.model.read();
		const effective = key === "api" ? this.host.effectiveApi(current) : this.host.effectiveBaseUrl(current);
		return effective ? { value: effective, via: "built-in" } : undefined;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read();
		const lines: string[] = [];
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			const key = row === "apiType" ? "api" : row;
			const override = current[key];
			const inherited = override ? undefined : this.inherited(key);
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: row === "apiType" ? "API Type" : row,
					valueText: override ?? inherited?.value ?? "not set",
					unset: !override,
					note: inherited ? `· ${inherited.via}` : undefined,
					active,
					paneFocused: this.focused,
					editing: row === "baseUrl" ? this.edit.editor(row) : undefined,
					width,
				}),
			);
		}

		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
		const hint = baseUrlHint(this.host.effectiveApi(current));
		if (hint) lines.push(renderInfoLine(theme, hint, width));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const next = moveSelection(kb, data, this.index, this.rows.length);
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.rows[this.index] === "apiType") this.host.pushPane(createModelApiPane(this.host, this.model));
			else this.beginEdit("tweak");
			return;
		}
		if (isPrintableInput(data)) {
			if (this.rows[this.index] === "apiType") return;
			this.beginEdit("overwrite", data);
			return;
		}
	}

	/** Tweak starts from the inherited value, so adjusting it writes the override directly. */
	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const base = this.model.read().baseUrl ?? this.inherited("baseUrl")?.value ?? "";
		this.edit.begin("baseUrl", base, mode, this.focused, (value) => this.commit(value), firstData);
	}

	private commit(raw: string): string | undefined {
		const value = raw.trim();
		if (value) {
			const invalid = validateBaseUrlValue(value);
			if (invalid) {
				return invalid;
			}
		}
		this.model.setField(["baseUrl"], value === "" ? DELETE : value);
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
		if (this.edit.editing)
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit / open"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/** Single-select model api: the inherited default plus every known API tag. Enter applies and returns. */
export function createModelApiPane(host: EditorHost, model: ModelHandle): EditorPane {
	const fallback = () => {
		const provider = host.store.getProvider(host.providerId);
		return provider?.api ?? builtinDefaults(host.providerId, model.read().id, provider?.api).api;
	};
	return new ChoicePane<string | undefined>(host, "API Type", {
		current: () => model.read().api,
		choices: () => {
			const providerApi = host.store.getProvider(host.providerId)?.api;
			const inherited = fallback();
			const label = providerApi
				? `provider: ${providerApi}`
				: inherited
					? `built-in: ${inherited}`
					: "no provider or built-in API";
			const values: (string | undefined)[] = [undefined, ...API_TYPES];
			const current = model.read().api;
			if (current && !values.includes(current)) values.push(current);
			return values.map((value) => ({ value, label: value ?? label, dim: value === undefined }));
		},
		choose: (value) => {
			if (value === undefined && !fallback()) return "Nothing to inherit — pick an API.";
			model.setField(["api"], value ?? DELETE);
			return undefined;
		},
	});
}
