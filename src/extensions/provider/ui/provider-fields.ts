/** Provider connection and API settings panes. */

import "../keybindings.ts";
import type { ModelsJsonProvider } from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults } from "../catalog.ts";
import { API_TYPES, maskApiKey, plural, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import { ChoicePane, InlineEdit, moveSelection } from "./controls.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { isPrintableInput, renderInfoLine, renderKeyValueLine, type ScrollWindowInfo } from "./value-row.ts";

/**
 * One-line guidance on the baseUrl shape an API tag expects: pi-ai delegates
 * URL assembly to the vendor SDKs, so OpenAI-style tags need the version path
 * in baseUrl while the Anthropic and Mistral clients append it themselves.
 */
export function baseUrlHint(api: string | undefined): string | undefined {
	switch (api) {
		case "openai-responses":
		case "openai-completions":
		case "openai-codex-responses":
			return "baseUrl includes the version path, e.g. https://api.openai.com/v1";
		case "anthropic-messages":
			return "baseUrl is the bare origin — /v1/messages is added automatically";
		case "mistral-conversations":
			return "baseUrl is the bare origin — /v1 is added automatically";
		case "google-generative-ai":
			return "baseUrl includes the version path, e.g. https://generativelanguage.googleapis.com/v1beta";
		default:
			return undefined;
	}
}

/** Shared baseUrl validation for provider-level and model-level entries; returns an error or undefined. */
export function validateBaseUrlValue(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "baseUrl must be a valid URL.";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `Unsupported protocol: ${url.protocol}`;
	}
	if (url.username || url.password || url.hash) {
		return "baseUrl must not contain credentials or a fragment.";
	}
	return undefined;
}

/**
 * The provider's connection page: baseUrl and apiKey edit in place, while
 * API Type pushes the single-select sub-page. Credential-source notes and
 * the per-API baseUrl hint stay pinned below the rows.
 */
export class ApiAuthPane implements EditorPane {
	private readonly rows = ["baseUrl", "apiKey", "apiType"] as const;
	private index = 0;
	private readonly edit: InlineEdit<"baseUrl" | "apiKey">;
	private focused = false;

	private readonly host: EditorHost;
	private readonly registry: Pick<ModelRegistry, "getProviderAuthStatus">;
	constructor(host: EditorHost, registry: Pick<ModelRegistry, "getProviderAuthStatus">) {
		this.host = host;
		this.edit = new InlineEdit(() => host.refresh());
		this.registry = registry;
	}

	private provider(): ModelsJsonProvider | undefined {
		return this.host.store.getProvider(this.host.providerId);
	}

	scrollWindow(): ScrollWindowInfo {
		// The value rows scroll; the credential-source notes stay pinned below.
		return { cursor: this.index, bottom: this.bottomNoteCount() };
	}

	private bottomNoteCount(): number {
		const status = this.registry.getProviderAuthStatus(this.host.providerId);
		const hint = baseUrlHint(this.provider()?.api);
		return (this.edit.error ? 1 : 0) + (status.configured ? 1 : 0) + 1 + (hint ? 1 : 0);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const provider = this.provider();
		const lines: string[] = [];
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			const key = row === "apiType" ? "api" : row;
			const value = provider?.[key];
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: row === "apiType" ? "API Type" : row,
					valueText: value ? (row === "apiKey" ? maskApiKey(value) : value) : "not set",
					unset: !value,
					active,
					paneFocused: this.focused,
					editing: row === "apiType" ? undefined : this.edit.editor(row),
					width,
				}),
			);
		}

		if (this.edit.error) lines.push(theme.fg("error", truncate(this.edit.error, Math.max(10, width - 2))));
		const status = this.registry.getProviderAuthStatus(this.host.providerId);
		if (status.configured && status.source === "stored") {
			lines.push(
				renderInfoLine(theme, "A stored credential (auth.json) takes precedence over the apiKey here.", width),
			);
		} else if (status.configured && status.source === "environment") {
			lines.push(
				renderInfoLine(
					theme,
					`An environment variable (${status.label ?? "env"}) currently provides the key.`,
					width,
				),
			);
		}
		lines.push(
			renderInfoLine(theme, "Values are stored raw; $VAR / !command references resolve at request time.", width),
		);
		const hint = baseUrlHint(provider?.api);
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
			const row = this.rows[this.index]!;
			if (row === "apiType") this.host.pushPane(createProviderApiPane(this.host));
			else this.beginEdit("tweak");
			return;
		}
		if (isPrintableInput(data)) {
			const row = this.rows[this.index]!;
			if (row === "apiType") return;
			this.beginEdit("overwrite", data);
			return;
		}
	}

	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const row = this.rows[this.index]!;
		if (row === "apiType") return;
		this.edit.begin(
			row,
			this.provider()?.[row] ?? "",
			mode,
			this.focused,
			(value) => this.commit(row, value),
			firstData,
		);
	}

	private commit(row: "baseUrl" | "apiKey", raw: string): string | undefined {
		const value = raw.trim();
		if (row === "baseUrl" && value) {
			const invalid = validateBaseUrlValue(value);
			if (invalid) {
				return invalid;
			}
		}
		if (row === "baseUrl" && !value) {
			// Removing baseUrl is only allowed while models still resolve an address.
			const builtin = builtinDefaults(this.host.providerId).baseUrl !== undefined;
			const modelsCovered = this.host.store
				.getModels(this.host.providerId)
				.every((model) => model.baseUrl !== undefined);
			if (!builtin && !modelsCovered && this.host.store.getModels(this.host.providerId).length > 0) {
				return "baseUrl cannot be removed while models rely on it.";
			}
		}
		this.host.edits.setProviderField([row], value === "" ? DELETE : value);
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
		if (this.edit.editing) {
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		}
		return [
			rawKeyHint("type", "overwrite"),
			keyHint("tui.select.confirm", "edit / open"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/**
 * Single-select provider api sub-page of API Auth; Enter applies and
 * returns. Clearing is refused while any model still resolves its api from
 * the provider — set a model-level API under Model-Specific API first.
 */
export function createProviderApiPane(host: EditorHost): EditorPane {
	const current = () => host.store.getProvider(host.providerId)?.api;
	return new ChoicePane<string | undefined>(host, "API Type", {
		current,
		choices: () => {
			const fallback = builtinDefaults(host.providerId).api;
			const label = fallback ? `not set (built-in default: ${fallback})` : "not set (models define their own)";
			const values: (string | undefined)[] = [undefined, ...API_TYPES];
			const value = current();
			if (value && !values.includes(value)) values.push(value);
			return values.map((value) => ({ value, label: value ?? label, dim: value === undefined }));
		},
		choose: (api) => {
			if (api === undefined) {
				const uncovered = host.store
					.getModels(host.providerId)
					.filter((model) => !model.api && !builtinDefaults(host.providerId, model.id).api);
				if (uncovered.length)
					return uncovered.length === 1
						? `Model "${uncovered[0].id}" resolves its API from here — give it a model-level API first.`
						: `${uncovered.length} ${plural(uncovered.length, "model")} resolve their API from here — give them model-level APIs first.`;
			}
			host.edits.setProviderField(["api"], api ?? DELETE);
			return undefined;
		},
	});
}
