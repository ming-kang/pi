/**
 * Use built-in data: pick a Pi builtin catalog entry as a reference for the
 * current model, preview per-field changes ("current → reference"), check the
 * fields to copy, and apply once. Selection and preview are temporary state;
 * Esc applies nothing. Identity/connection fields (provider, id, api,
 * baseUrl, keys) are never touched.
 */

import "../keybindings.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import {
	type CatalogEntry,
	type CatalogMatch,
	computeFieldChanges,
	type FieldChange,
	matchBuiltinModels,
} from "../catalog.ts";
import { formatTokens, plural, truncate } from "../constants.ts";
import { getPath } from "../json-fields.ts";
import { jsonEquals } from "../store.ts";
import { FilterListPane, moveSelection } from "./controls.ts";
import type { EditorPane, ModelHandle, ProviderPaneHost } from "./pane.ts";
import { renderInfoLine, renderPlainLine, type ScrollWindowInfo } from "./value-row.ts";

/**
 * What tells two candidates apart, in the Fetch models wording. The API shows
 * only when it differs from the model's, since that is what makes a
 * candidate's thinking map and compat view-only.
 */
function candidateNote(model: Model<Api>, effectiveApi: string | undefined): string {
	return [
		`${formatTokens(model.contextWindow)} ctx`,
		`${formatTokens(model.maxTokens)} out`,
		model.input.includes("image") ? "img" : "",
		model.reasoning ? "think" : "",
		model.api === effectiveApi ? "" : model.api,
	]
		.filter(Boolean)
		.map((part) => `· ${part}`)
		.join(" ");
}

export class BuiltinCandidatesPane extends FilterListPane<CatalogMatch> {
	constructor(host: ProviderPaneHost, model: ModelHandle) {
		super(host, {
			crumb: "Use built-in data",
			initialQuery: model.read().id ?? "",
			items: (query) => matchBuiltinModels(query, host.effectiveApi(model.read())),
			renderItem: (match, { active, focused, width }) => {
				const { providerId, model: ref } = match.entry;
				return renderPlainLine(host.theme, `${providerId} / ${ref.id}`, {
					active,
					paneFocused: focused,
					note: candidateNote(ref, host.effectiveApi(model.read())),
					width,
				});
			},
			emptyMessage: "No built-in candidates — keep configuring manually.",
			footer: () => ["A reference to copy fields from; the model's id and API stay."],
			confirmVerb: "preview",
			onConfirm: (match) => host.pushPane(new BuiltinPreviewPane(host, model, match.entry)),
		});
	}
}

export class BuiltinPreviewPane implements EditorPane {
	readonly crumb = "Use built-in data · preview";
	private readonly changes: FieldChange[];
	/** Rows whose reference value the model already has: shown for context, never checkable. */
	private readonly same: boolean[];
	private readonly checked: boolean[];
	private readonly snapshot: Partial<ModelsJsonModel> & { id?: string };
	private readonly snapshotApi: string | undefined;
	private index = 0;
	private expanded: number | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: ProviderPaneHost;
	private readonly model: ModelHandle;
	private readonly reference: CatalogEntry;
	constructor(host: ProviderPaneHost, model: ModelHandle, reference: CatalogEntry) {
		this.host = host;
		this.model = model;
		this.reference = reference;

		const current = model.read();
		this.snapshot = structuredClone(current);
		this.snapshotApi = host.effectiveApi(current);
		this.changes = computeFieldChanges(current, reference.model, host.effectiveApi(current));
		this.same = this.changes.map(
			(change) =>
				change.patches.length > 0 &&
				change.patches.every((patch) => jsonEquals(getPath(current, patch.path), patch.value)),
		);
		this.checked = this.changes.map((change, index) => change.checked && this.canApply(index));
		// Start on the first row that can change something; with none, on the closing row.
		const first = this.changes.findIndex((_, index) => this.canApply(index));
		this.index = first >= 0 ? first : this.changes.length;
	}

	private canApply(index: number): boolean {
		return this.changes[index]!.applicable && !this.same[index];
	}

	private chosen(): FieldChange[] {
		return this.changes.filter((_, index) => this.checked[index] && this.canApply(index));
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
			const same = this.same[rowIndex];
			const text = same
				? `${change.field}: ${change.referenceText}`
				: `${change.field}: ${change.currentText} → ${change.referenceText}`;
			lines.push(
				// Rows without a checkbox indent to the same column as those with one.
				renderPlainLine(theme, this.canApply(rowIndex) ? text : `    ${text}`, {
					checked: this.canApply(rowIndex) ? this.checked[rowIndex] : undefined,
					active,
					paneFocused: this.focused,
					dim: same,
					note: same ? "· already set" : change.applicable ? undefined : "· another API, view only",
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
		const count = this.chosen().length;
		lines.push(
			renderPlainLine(theme, count > 0 ? `Apply ${count} ${plural(count, "field")}` : "Nothing checked", {
				active: this.index === this.changes.length,
				paneFocused: this.focused,
				dim: count === 0,
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
		const next = moveSelection(kb, data, this.index, this.rowCount());
		if (next !== undefined) {
			this.index = next;
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
			if (!this.canApply(this.index)) {
				if (change.referenceDetails) this.expanded = this.expanded === this.index ? undefined : this.index;
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
			} else if (this.canApply(this.index)) {
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
		const chosen = this.chosen();
		if (chosen.length === 0) {
			this.host.popPane();
			return;
		}
		this.host.edits.batch(() => {
			for (const change of chosen) {
				for (const patch of change.patches) this.model.setField(patch.path, patch.value);
			}
		});
		this.host.notify(
			`Applied ${chosen.length} ${plural(chosen.length, "field")} from ${this.reference.providerId} / ${this.reference.model.id}.`,
			"info",
		);
		this.host.popPane(); // preview
		this.host.popPane(); // candidates → back to the model fields
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	/** Only what the selected row answers to. */
	hints(): string {
		const back = keyHint("tui.select.cancel", "back");
		const change = this.changes[this.index];
		if (!change)
			return [keyHint("tui.select.confirm", this.chosen().length > 0 ? "apply" : "close"), back].join("  ");
		const hints: string[] = [];
		if (this.canApply(this.index)) hints.push(keyHint("app.list.toggle", "check"));
		if (change.referenceDetails) hints.push(keyHint("tui.select.confirm", "details"));
		else if (this.canApply(this.index)) hints.push(keyHint("tui.select.confirm", "check"));
		return [rawKeyHint("↑↓", "navigate"), ...hints, back].join("  ");
	}
}
