/** Scalar model settings: reasoning, input modalities, cost rates, and the model-specific API override. */

import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults } from "../catalog.ts";
import { API_TYPES, INPUT_TYPES, type InputType, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { baseUrlHint, validateBaseUrlValue } from "./provider-fields.ts";
import { isPrintableInput, renderInfoLine, renderKeyValueLine, renderPlainLine, ValueEditor } from "./value-row.ts";

// -------------------------------------------------------------------------
// reasoning
// -------------------------------------------------------------------------

const REASONING_OPTIONS = [
	{ label: "true", value: true },
	{ label: "false", value: false },
	{ label: "default (false)", value: undefined },
] as const;

/** Radio sub-page for reasoning — consistent with the other nested model settings. */
export class ReasoningPane implements EditorPane {
	readonly crumb = "reasoning";
	private index = 0;
	private focused = false;
	private readonly host: EditorHost;
	private readonly model: ModelHandle;

	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
		const current = model.read().reasoning;
		this.index = current === true ? 0 : current === false ? 1 : 2;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read().reasoning;
		return REASONING_OPTIONS.map((option, optionIndex) => {
			const selected = option.value === undefined ? current === undefined : current === option.value;
			return renderPlainLine(theme, `${selected ? "●" : "○"} ${option.label}`, {
				active: optionIndex === this.index,
				paneFocused: this.focused,
				dim: option.value === undefined,
				width,
			});
		});
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? REASONING_OPTIONS.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % REASONING_OPTIONS.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const option = REASONING_OPTIONS[this.index]!;
			this.host.mutate(() => this.model.setField(["reasoning"], option.value === undefined ? DELETE : option.value));
			this.host.popPane();
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "set"),
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
			lines.push(renderInfoLine(theme, "Not set — the runtime default is [text].", width));
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
		const editor = new ValueEditor({
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
		this.host.mutate(() => {
			if (this.model.read().cost) this.model.setField(["cost", rate], parsed);
			else this.model.setField(["cost"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [rate]: parsed });
		});
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
	private editing: ValueEditor | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
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
			if (row === "baseUrl") {
				const override = current.baseUrl;
				const inherited = override ? undefined : this.inherited("baseUrl");
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "baseUrl",
						valueText: override ?? inherited?.value ?? "not set",
						unset: !override,
						note: inherited ? `· ${inherited.via}` : undefined,
						active,
						paneFocused: this.focused,
						editing: this.editing,
						width,
					}),
				);
			} else {
				const override = current.api;
				const inherited = override ? undefined : this.inherited("api");
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "API Type",
						valueText: override ?? inherited?.value ?? "not set",
						unset: !override,
						note: inherited ? `· ${inherited.via}` : undefined,
						active,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		const hint = baseUrlHint(this.host.effectiveApi(current));
		if (hint) lines.push(renderInfoLine(theme, hint, width));
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
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.rows[this.index] === "apiType") this.host.pushPane(new ModelApiTypePane(this.host, this.model));
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
		const current = this.model.read();
		const base = current.baseUrl ?? this.inherited("baseUrl")?.value ?? "";
		const editor = new ValueEditor({
			onCommit: (value) => this.commit(value),
			onCancel: () => {
				this.editing = undefined;
				this.error = undefined;
				this.host.refresh();
			},
		});
		this.editing = editor;
		editor.focused = this.focused;
		if (mode === "overwrite") editor.beginOverwrite(firstData);
		else editor.beginTweak(base);
		this.host.refresh();
	}

	private commit(raw: string): void {
		const value = raw.trim();
		if (value) {
			const invalid = validateBaseUrlValue(value);
			if (invalid) {
				this.error = invalid;
				this.host.refresh();
				return;
			}
		}
		this.error = undefined;
		this.editing = undefined;
		this.host.mutate(() => this.model.setField(["baseUrl"], value === "" ? DELETE : value));
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
			keyHint("tui.select.confirm", "edit / open"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/** Single-select model api: the inherited default plus every known API tag. Enter applies and returns. */
export class ModelApiTypePane implements EditorPane {
	readonly crumb = "API Type";
	private index = 0;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;

		const current = model.read().api;
		const options = this.options();
		this.index = Math.max(
			0,
			options.findIndex((option) => option.value === current),
		);
	}

	/** The api this model inherits when it defines none — provider first, then the built-in catalog. */
	private fallback(): string | undefined {
		const provider = this.host.store.getProvider(this.host.providerId);
		return provider?.api ?? builtinDefaults(this.host.providerId, this.model.read().id, provider?.api).api;
	}

	/** value undefined = inherit; a custom api already stored is preserved and appended. */
	private options(): { label: string; value: string | undefined }[] {
		const current = this.model.read().api;
		const providerApi = this.host.store.getProvider(this.host.providerId)?.api;
		const fallback = this.fallback();
		const inheritedLabel = providerApi
			? `provider: ${providerApi}`
			: fallback
				? `built-in: ${fallback}`
				: "no provider or built-in API";
		const options: { label: string; value: string | undefined }[] = [{ label: inheritedLabel, value: undefined }];
		for (const api of API_TYPES) options.push({ label: api, value: api });
		if (current && !(API_TYPES as readonly string[]).includes(current))
			options.push({ label: current, value: current });
		return options;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.model.read().api;
		const lines = this.options().map((option, rowIndex) => {
			const selected = option.value === current;
			return renderPlainLine(theme, `${selected ? "●" : "○"} ${option.label}`, {
				active: rowIndex === this.index,
				paneFocused: this.focused,
				dim: option.value === undefined,
				width,
			});
		});
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const options = this.options();
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? options.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % options.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.list.toggle")) {
			const option = options[this.index]!;
			if (option.value === undefined && !this.fallback()) {
				this.error = "Nothing to inherit — pick an API.";
				this.host.refresh();
				return;
			}
			this.error = undefined;
			this.host.mutate(() => this.model.setField(["api"], option.value ?? DELETE));
			this.host.popPane();
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "select"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
