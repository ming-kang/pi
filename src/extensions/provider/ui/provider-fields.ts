/** Provider connection and API settings panes. */

import type { ModelsJsonProvider } from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults } from "../catalog.ts";
import { API_TYPES, maskApiKey, plural, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import {
	isPrintableInput,
	renderInfoLine,
	renderKeyValueLine,
	renderPlainLine,
	type ScrollWindowInfo,
	ValueEditor,
} from "./value-row.ts";

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
	private editing: ValueEditor | undefined;
	private editingRow: "baseUrl" | "apiKey" | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly registry: Pick<ModelRegistry, "getProviderAuthStatus">;
	constructor(host: EditorHost, registry: Pick<ModelRegistry, "getProviderAuthStatus">) {
		this.host = host;
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
		return (this.error ? 1 : 0) + (status.configured ? 1 : 0) + 1 + (hint ? 1 : 0);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const provider = this.provider();
		const lines: string[] = [];
		for (const [rowIndex, row] of this.rows.entries()) {
			const active = rowIndex === this.index;
			if (row === "baseUrl") {
				const value = provider?.baseUrl;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "baseUrl",
						valueText: value ?? "not set",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "baseUrl" ? this.editing : undefined,
						width,
					}),
				);
			} else if (row === "apiKey") {
				const value = provider?.apiKey;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "apiKey",
						valueText: value ? maskApiKey(value) : "not set",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "apiKey" ? this.editing : undefined,
						width,
					}),
				);
			} else {
				const value = provider?.api;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "API Type",
						valueText: value ?? "not set",
						unset: !value,
						active,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
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
		if (this.editing) {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return; // stay while editing
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
			const row = this.rows[this.index]!;
			if (row === "apiType") this.host.pushPane(new ApiTypePane(this.host));
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
		if (row !== "baseUrl" && row !== "apiKey") return;
		const current = row === "baseUrl" ? (this.provider()?.baseUrl ?? "") : (this.provider()?.apiKey ?? "");
		const editor = new ValueEditor({
			onCommit: (value) => this.commit(row, value),
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
		else editor.beginTweak(current);
		this.host.refresh();
	}

	private commit(row: "baseUrl" | "apiKey", raw: string): void {
		const value = raw.trim();
		if (row === "baseUrl" && value) {
			const invalid = validateBaseUrlValue(value);
			if (invalid) {
				this.error = invalid;
				this.host.refresh();
				return;
			}
		}
		if (row === "baseUrl" && !value) {
			// Removing baseUrl is only allowed while models still resolve an address.
			const builtin = builtinDefaults(this.host.providerId).baseUrl !== undefined;
			const modelsCovered = this.host.store
				.getModels(this.host.providerId)
				.every((model) => model.baseUrl !== undefined);
			if (!builtin && !modelsCovered && this.host.store.getModels(this.host.providerId).length > 0) {
				this.error = "baseUrl cannot be removed while models rely on it.";
				this.host.refresh();
				return;
			}
		}
		this.error = undefined;
		this.editing = undefined;
		this.editingRow = undefined;
		this.host.mutate(() =>
			this.host.store.setProviderField(this.host.providerId, [row], value === "" ? DELETE : value),
		);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editing) this.editing.focused = focused;
	}

	isEditing(): boolean {
		return this.editing !== undefined;
	}

	hints(): string {
		if (this.editing) {
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
export class ApiTypePane implements EditorPane {
	readonly crumb = "API Type";
	private index = 0;
	private focused = false;
	private error: string | undefined;

	private readonly host: EditorHost;
	constructor(host: EditorHost) {
		this.host = host;

		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const options = this.options();
		this.index = Math.max(0, options.indexOf(current));
	}

	/** undefined first = not set; a custom api already stored is preserved and appended. */
	private options(): (string | undefined)[] {
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const base: (string | undefined)[] = [undefined, ...API_TYPES];
		if (current && !(API_TYPES as readonly string[]).includes(current)) base.push(current);
		return base;
	}

	private unsetLabel(): string {
		const fallback = builtinDefaults(this.host.providerId).api;
		return fallback ? `not set (built-in default: ${fallback})` : "not set (models define their own)";
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const lines = this.options().map((option, rowIndex) => {
			const active = rowIndex === this.index;
			const selected = option === current;
			const label = `${selected ? "●" : "○"} ${option ?? this.unsetLabel()}`;
			return renderPlainLine(theme, label, { active, paneFocused: this.focused, dim: option === undefined, width });
		});
		if (this.error) lines.push(renderInfoLine(theme, this.error, width));
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		return { cursor: this.index, bottom: this.error ? 1 : 0 };
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
			const option = options[this.index];
			if (option === undefined) {
				const uncovered = this.host.store
					.getModels(this.host.providerId)
					.filter((model) => !model.api && !builtinDefaults(this.host.providerId, model.id).api);
				if (uncovered.length > 0) {
					this.error =
						uncovered.length === 1
							? `Model "${uncovered[0]!.id}" resolves its API from here — give it a model-level API first.`
							: `${uncovered.length} ${plural(uncovered.length, "model")} resolve their API from here — give them model-level APIs first.`;
					this.host.refresh();
					return;
				}
			}
			this.error = undefined;
			this.host.mutate(() => this.host.store.setProviderField(this.host.providerId, ["api"], option ?? DELETE));
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
