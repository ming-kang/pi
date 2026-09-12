/**
 * Use Built-in Data: pick a Pi builtin catalog entry as a reference for the
 * current model, preview per-field changes ("current → reference"), check the
 * fields to copy, and apply once. Selection and preview are temporary state;
 * Esc applies nothing. Identity/connection fields (provider, id, api,
 * baseUrl, keys) are never touched.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { type CatalogEntry, computeFieldChanges, type FieldChange, matchBuiltinModels } from "../catalog.ts";
import { truncate } from "../constants.ts";
import { jsonEquals } from "../store.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { renderInfoLine, renderPlainLine, type ScrollWindowInfo, ValueEditor } from "./value-row.ts";

function formatContext(model: Model<Api>): string {
	const ctx = model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1024)}k` : String(model.contextWindow);
	return `${model.api} · ${ctx} ctx${model.reasoning ? " · reasoning" : ""}`;
}

export class BuiltinCandidatesPane implements EditorPane {
	readonly crumb = "Use Built-in Data";
	private readonly search: ValueEditor;
	private query: string;
	private index = 0;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;

		this.query = this.model.read().id ?? "";
		this.search = new ValueEditor({
			onCommit: () => this.pickCurrent(),
			onCancel: () => this.host.popPane(),
		});
		this.search.reset(this.query);
	}

	private candidates(): CatalogEntry[] {
		return matchBuiltinModels(this.query, this.host.effectiveApi(this.model.read())).map((match) => match.entry);
	}

	private tiers(): ReturnType<typeof matchBuiltinModels> {
		return matchBuiltinModels(this.query, this.host.effectiveApi(this.model.read()));
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [this.search.renderLine(width)];
		const matches = this.tiers();
		if (matches.length === 0) {
			lines.push(renderInfoLine(theme, "No builtin candidates — keep configuring manually.", width));
		}
		for (const [rowIndex, match] of matches.entries()) {
			const { providerId, model } = match.entry;
			const label = `${providerId} / ${model.id}`;
			const note =
				(match.tier === "exact" ? "exact · " : "") +
				`${model.name !== model.id ? `${model.name} · ` : ""}${formatContext(model)}`;
			lines.push(
				renderPlainLine(theme, label, {
					active: rowIndex === this.index,
					paneFocused: this.focused,
					note,
					width,
				}),
			);
		}
		lines.push(
			renderInfoLine(theme, "Candidates are a reference only; the configured id is never rewritten.", width),
		);
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The filter input pins above, the reference disclaimer below.
		return { top: 1, bottom: 1, cursor: 1 + this.index };
	}

	private pickCurrent(): void {
		const entry = this.candidates()[this.index];
		if (!entry) return;
		this.host.pushPane(new BuiltinPreviewPane(this.host, this.model, entry));
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const count = this.candidates().length;
		if (kb.matches(data, "tui.select.up")) {
			if (count > 0) this.index = this.index === 0 ? count - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (count > 0) this.index = (this.index + 1) % count;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.pickCurrent();
			return;
		}
		const before = this.query;
		this.search.handleInput(data);
		this.query = this.search.value;
		if (this.query !== before) this.index = 0;
		this.host.refresh();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.search.focused = focused;
	}

	isEditing(): boolean {
		return true; // the candidate filter always owns ←/→
	}

	hints(): string {
		return [
			rawKeyHint("type", "filter"),
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "preview"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

export class BuiltinPreviewPane implements EditorPane {
	readonly crumb = "Use Built-in Data · preview";
	private readonly changes: FieldChange[];
	private readonly checked: boolean[];
	private readonly snapshot: Partial<ModelsJsonModel> & { id?: string };
	private readonly snapshotApi: string | undefined;
	private index = 0;
	private expanded: number | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	private readonly reference: CatalogEntry;
	constructor(host: EditorHost, model: ModelHandle, reference: CatalogEntry) {
		this.host = host;
		this.model = model;
		this.reference = reference;

		const current = model.read();
		this.snapshot = structuredClone(current);
		this.snapshotApi = host.effectiveApi(current);
		this.changes = computeFieldChanges(current, reference.model, host.effectiveApi(current));
		this.checked = this.changes.map((change) => change.checked && change.applicable);
	}

	private rowCount(): number {
		return this.changes.length + 1; // + Apply row
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [
			renderInfoLine(theme, `reference: ${this.reference.providerId} / ${this.reference.model.id}`, width),
		];
		for (const [rowIndex, change] of this.changes.entries()) {
			const active = rowIndex === this.index;
			const expandable = change.referenceDetails !== undefined;
			const note = !change.applicable ? "· view only" : undefined;
			lines.push(
				renderPlainLine(theme, `${change.field}: ${change.currentText} → ${change.referenceText}`, {
					checked: change.applicable ? this.checked[rowIndex] : undefined,
					active,
					paneFocused: this.focused,
					note,
					width,
				}),
			);
			if (this.expanded === rowIndex && expandable) {
				for (const detail of change.referenceDetails!) {
					lines.push(renderInfoLine(theme, `    ${detail}`, width));
				}
				if (change.referenceHasTiers) {
					lines.push(renderInfoLine(theme, "    reference has cost tiers — tiers are never imported.", width));
				}
			}
		}
		lines.push(
			renderPlainLine(theme, "Apply Selected Fields", {
				active: this.index === this.changes.length,
				paneFocused: this.focused,
				width,
			}),
		);
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		// The reference header pins above; errors pin below. Expanded detail
		// lines shift the cursor row when they sit above it.
		let cursor = 1 + this.index;
		if (this.expanded !== undefined && this.expanded < this.index) {
			const change = this.changes[this.expanded]!;
			if (change.referenceDetails) {
				cursor += change.referenceDetails.length + (change.referenceHasTiers ? 1 : 0);
			}
		}
		return { top: 1, bottom: this.error ? 1 : 0, cursor };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
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
		if (kb.matches(data, "app.list.toggle")) {
			const change = this.changes[this.index];
			if (!change) return;
			if (!change.applicable) {
				this.expanded = this.expanded === this.index ? undefined : this.index;
				this.host.refresh();
				return;
			}
			this.checked[this.index] = !this.checked[this.index];
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.index === this.changes.length) {
				this.apply();
				return;
			}
			const change = this.changes[this.index]!;
			if (change.referenceDetails) {
				this.expanded = this.expanded === this.index ? undefined : this.index;
			} else if (change.applicable) {
				this.checked[this.index] = !this.checked[this.index];
			}
			this.host.refresh();
			return;
		}
	}

	private apply(): void {
		// Re-validate against the live model: a stale preview must not write to a changed model.
		const current = this.model.read();
		if (this.host.effectiveApi(current) !== this.snapshotApi) {
			this.error = "The API changed since this preview opened; reopen to continue.";
			this.host.refresh();
			return;
		}
		if (!current.id || !jsonEquals(current, this.snapshot)) {
			this.error = "The model changed since this preview opened; reopen to continue.";
			this.host.refresh();
			return;
		}
		const chosen = this.changes.filter((_, rowIndex) => this.checked[rowIndex] && this.changes[rowIndex]!.applicable);
		if (chosen.length === 0) {
			this.host.popPane();
			return;
		}
		this.host.store.batch(() => {
			for (const change of chosen) this.applyChange(change.field);
		});
		this.host.refresher.touch(this.host.providerId);
		this.host.notify(
			`Applied ${chosen.length} field${chosen.length === 1 ? "" : "s"} from ${this.reference.providerId} / ${this.reference.model.id}.`,
			"info",
		);
		this.host.popPane(); // preview
		this.host.popPane(); // candidates → back to the model fields
	}

	private applyChange(field: FieldChange["field"]): void {
		const reference = this.reference.model;
		const current = this.model.read();
		switch (field) {
			case "name":
				this.model.setField(["name"], reference.name);
				return;
			case "reasoning":
				this.model.setField(["reasoning"], reference.reasoning);
				return;
			case "input":
				this.model.setField(["input"], [...reference.input]);
				return;
			case "contextWindow":
				this.model.setField(["contextWindow"], reference.contextWindow);
				return;
			case "maxTokens":
				this.model.setField(["maxTokens"], reference.maxTokens);
				return;
			case "thinkingLevelMap":
				for (const [level, target] of Object.entries(reference.thinkingLevelMap ?? {})) {
					this.model.setField(["thinkingLevelMap", level], target);
				}
				return;
			case "compat":
				for (const [key, value] of Object.entries(reference.compat ?? {})) {
					if (
						["chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting"].includes(
							key,
						) &&
						value !== null &&
						typeof value === "object" &&
						!Array.isArray(value)
					) {
						for (const [entryKey, entryValue] of Object.entries(value))
							this.model.setField(["compat", key, entryKey], structuredClone(entryValue));
					} else this.model.setField(["compat", key], structuredClone(value));
				}
				return;
			case "cost": {
				const rates = {
					input: reference.cost.input,
					output: reference.cost.output,
					cacheRead: reference.cost.cacheRead,
					cacheWrite: reference.cost.cacheWrite,
				};
				if (current.cost) {
					for (const [rate, value] of Object.entries(rates)) this.model.setField(["cost", rate], value);
				} else this.model.setField(["cost"], rates);
				return;
			}
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			keyHint("app.list.toggle", "check"),
			keyHint("tui.select.confirm", "details / apply"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
