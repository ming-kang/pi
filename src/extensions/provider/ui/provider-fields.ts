/** Provider Authentication and API settings panes. */

import "../keybindings.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ModelsJsonProvider } from "../../../core/model-config.ts";
import type { AuthStatus } from "../../../core/provider-composer.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults, isBuiltinProviderId } from "../catalog.ts";
import { API_TYPES, apiTypeLabel, maskApiKey, plural } from "../constants.ts";
import { DELETE } from "../store.ts";
import { AdvancedPane, advancedNote, PROVIDER_ADVANCED_FIELDS, providerAdvancedTarget } from "./advanced.ts";
import { ChoicePane, InlineEdit, moveSelection } from "./controls.ts";
import { type CredentialRuntime, CredentialState } from "./credential.ts";
import type { EditorPane, ProviderPaneHost } from "./pane.ts";
import {
	isPrintableInput,
	renderErrorLines,
	renderInfoLine,
	renderKeyValueLine,
	type ScrollWindowInfo,
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
			return "baseUrl includes the version path, e.g. /v1";
		case "anthropic-messages":
			return "baseUrl is the bare origin; /v1/messages is appended";
		case "mistral-conversations":
			return "baseUrl is the bare origin; /v1 is appended";
		case "google-generative-ai":
			return "baseUrl includes the version path, e.g. /v1beta";
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

/** The empty baseUrl's placeholder, following the same convention as baseUrlHint. */
function baseUrlPlaceholder(api: string | undefined): string {
	switch (api) {
		case "anthropic-messages":
		case "mistral-conversations":
			return "https://api.example.com";
		case "google-generative-ai":
			return "https://api.example.com/v1beta";
		default:
			return "https://api.example.com/v1";
	}
}

type AuthRow = "credential" | "logout" | "baseUrl" | "apiKey" | "apiType" | "advanced";

/**
 * The provider's Authentication page. A built-in leads with its Credential
 * (what /login stored, replaced by typing a key, removed by Log out); every
 * provider edits baseUrl and apiKey in place, and API Type pushes the
 * single-select sub-page. Notes and action results stay pinned below.
 */
export class AuthenticationPane implements EditorPane {
	private index = 0;
	private readonly edit: InlineEdit<"credential" | "baseUrl" | "apiKey">;
	private focused = false;
	/** Lines below the rows in the last render: error, result, and notes. */
	private footerLines = 0;

	private readonly host: ProviderPaneHost;
	private readonly runtime: CredentialRuntime;
	private readonly credential: CredentialState | undefined;
	private readonly builtin: boolean;
	/** API Type and apiKey on a built-in appear only once models.json sets them. */
	private readonly showApiType: boolean;
	private readonly showApiKey: boolean;

	constructor(host: ProviderPaneHost, runtime: CredentialRuntime) {
		this.host = host;
		this.runtime = runtime;
		this.edit = new InlineEdit(() => host.refresh());
		this.builtin = isBuiltinProviderId(host.providerId);
		// A provider-level api reaches only models.json-defined models, never a built-in catalog.
		this.showApiType = !this.builtin || this.provider()?.api !== undefined;
		this.showApiKey = !this.builtin || this.provider()?.apiKey !== undefined;
		this.credential = this.builtin ? new CredentialState(runtime, host.providerId, () => host.refresh()) : undefined;
	}

	private provider(): ModelsJsonProvider | undefined {
		return this.host.store.getProvider(this.host.providerId);
	}

	private rows(): AuthRow[] {
		const rows: AuthRow[] = [];
		if (this.credential) rows.push("credential");
		if (this.credential?.stored) rows.push("logout");
		rows.push("baseUrl");
		if (this.showApiKey) rows.push("apiKey");
		if (this.showApiType) rows.push("apiType");
		rows.push("advanced");
		return rows;
	}

	scrollWindow(): ScrollWindowInfo {
		// The value rows scroll; errors and the credential-source notes stay pinned below.
		return { cursor: this.index, bottom: this.footerLines };
	}

	/**
	 * Where the key comes from, read against the unsaved view: auth.json wins
	 * over models.json, which wins over the environment, so an apiKey typed
	 * here hides the environment note immediately instead of after a reload.
	 */
	private notes(): string[] {
		const provider = this.provider();
		const status = this.runtime.getProviderAuthStatus(this.host.providerId);
		const notes: string[] = [];
		if (this.credential) notes.push(...this.credentialNotes(status));
		if (this.showApiKey) {
			if (status.configured && status.source === "stored") {
				notes.push("The credential in auth.json overrides this apiKey.");
			} else if (!this.credential && status.configured && status.source === "environment" && !provider?.apiKey) {
				notes.push(`The key currently comes from env ${status.label ?? "variable"}.`);
			}
			notes.push("Saved as typed; $VAR and !command resolve when sent.");
		}
		const hint = baseUrlHint(provider?.api);
		if (hint) notes.push(hint);
		return notes;
	}

	/** Short lines, so they fit the right pane of an 80-column terminal. */
	private credentialNotes(status: AuthStatus): string[] {
		if (this.credential?.oauth)
			return [`/login ${this.host.providerId} signs in again.`, "A typed key replaces the OAuth login."];
		if (this.credential?.stored) return ["Type a key to replace it in auth.json, as /login does."];
		if (status.configured && status.source === "environment")
			return ["Type a key to save it to auth.json, over the env var."];
		return ["Type a key to save it to auth.json, as /login does."];
	}

	private renderRow(row: AuthRow, active: boolean, width: number): string {
		const theme = this.host.theme;
		const paneFocused = this.focused;
		switch (row) {
			case "credential": {
				const state = this.credential!;
				const { text, unset } = state.describe();
				return renderKeyValueLine(theme, {
					keyLabel: "Credential",
					valueText: text,
					unset,
					note: state.busy ? `· ${state.busy}` : undefined,
					active,
					paneFocused,
					editing: this.edit.editor("credential"),
					width,
				});
			}
			case "logout":
				return renderKeyValueLine(theme, {
					valueText: "Log out",
					note: this.credential?.oauth ? "· removes the OAuth login" : "· removes the saved key",
					active,
					paneFocused,
					width,
				});
			case "advanced":
				return renderKeyValueLine(theme, {
					valueText: "Advanced",
					note: advancedNote(providerAdvancedTarget(this.host), PROVIDER_ADVANCED_FIELDS),
					active,
					paneFocused,
					width,
				});
			default: {
				const key = row === "apiType" ? "api" : row;
				const value = this.provider()?.[key];
				// A built-in provider's unset rows show the catalog value they fall back to.
				const fallback = key === "apiKey" ? undefined : builtinDefaults(this.host.providerId)[key];
				return renderKeyValueLine(theme, {
					keyLabel: row === "apiType" ? "API Type" : row,
					valueText: value ? (row === "apiKey" ? maskApiKey(value) : value) : (fallback ?? "not set"),
					unset: !value,
					note: !value && fallback ? "· built-in" : undefined,
					active,
					paneFocused,
					editing: row === "apiType" ? undefined : this.edit.editor(row),
					width,
				});
			}
		}
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const rows = this.rows();
		this.index = Math.min(this.index, rows.length - 1);
		const lines = rows.map((row, index) => this.renderRow(row, index === this.index, width));
		const rowCount = lines.length;
		if (this.edit.error) lines.push(...renderErrorLines(theme, this.edit.error, width));
		const result = this.credential?.result;
		if (result && !this.edit.editing) {
			lines.push(
				...(result.error
					? renderErrorLines(theme, result.text, width)
					: [truncateToWidth(theme.fg("success", result.text), width)]),
			);
		}
		const notes = this.notes();
		// A blank line keeps the notes from reading as one more row.
		if (notes.length > 0) lines.push("");
		for (const note of notes) lines.push(renderInfoLine(theme, note, width));
		this.footerLines = lines.length - rowCount;
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const rows = this.rows();
		const next = moveSelection(kb, data, this.index, rows.length);
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		const row = rows[this.index]!;
		if (kb.matches(data, "tui.select.confirm")) {
			if (row === "apiType") this.host.pushPane(createProviderApiPane(this.host));
			else if (row === "advanced")
				this.host.pushPane(
					new AdvancedPane(this.host, providerAdvancedTarget(this.host), PROVIDER_ADVANCED_FIELDS),
				);
			else if (row === "logout") this.confirmLogout();
			else this.beginEdit(row, row === "credential" ? "overwrite" : "tweak");
			return;
		}
		if (isPrintableInput(data) && row !== "apiType" && row !== "advanced" && row !== "logout") {
			this.beginEdit(row, "overwrite", data);
		}
	}

	private confirmLogout(): void {
		const credential = this.credential!;
		const what = credential.oauth ? "OAuth login" : "saved API key";
		this.host.confirm(
			`Log out of ${this.host.providerId}? This removes its ${what} from auth.json.`,
			"Log out",
			() => {
				this.host.popPane();
				this.index = 0;
				credential.logout();
			},
		);
	}

	private beginEdit(row: "credential" | "baseUrl" | "apiKey", mode: "overwrite" | "tweak", firstData?: string): void {
		// A stored key never comes back into the panel, so the Credential always starts empty.
		const current = row === "credential" ? "" : (this.provider()?.[row] ?? "");
		// Only a first baseUrl leads on to apiKey; re-editing an address stays put.
		const firstBaseUrl = row === "baseUrl" && current === "";
		this.edit.begin(row, current, mode, this.focused, (value) => this.commit(row, value), firstData, {
			placeholder: this.placeholder(row),
			placeholderStyle: (text) => this.host.theme.fg("dim", text),
			onDone: firstBaseUrl ? () => this.advanceToApiKey() : undefined,
		});
	}

	private placeholder(row: "credential" | "baseUrl" | "apiKey"): string {
		switch (row) {
			case "credential":
				return "paste the API key";
			case "apiKey":
				return "sk-…, $ENV_VAR, or !command";
			case "baseUrl":
				return baseUrlPlaceholder(this.provider()?.api);
		}
	}

	/** New-provider setup: open the empty baseUrl, so the next paste fills it. */
	beginSetup(): void {
		if (this.provider()?.baseUrl) return;
		this.index = this.rows().indexOf("baseUrl");
		this.beginEdit("baseUrl", "overwrite");
	}

	/** After a first baseUrl, a provider without any key opens apiKey next, ready for the paste. */
	private advanceToApiKey(): void {
		if (!this.provider()?.baseUrl || this.provider()?.apiKey) return;
		if (this.runtime.getProviderAuthStatus(this.host.providerId).configured) return;
		const next = this.rows().indexOf("apiKey");
		if (next < 0) return;
		this.index = next;
		this.beginEdit("apiKey", "overwrite");
	}

	private commit(row: "credential" | "baseUrl" | "apiKey", raw: string): string | undefined {
		const value = raw.trim();
		if (row === "credential") {
			const invalid = this.credential!.validateKey(value);
			if (!invalid) this.credential!.replaceKey(value);
			return invalid;
		}
		if (row === "baseUrl" && value) {
			const invalid = validateBaseUrlValue(value);
			if (invalid) {
				return invalid;
			}
		}
		if (row === "baseUrl" && !value) {
			// Removing baseUrl is only allowed while models still resolve an address.
			const modelsCovered = this.host.store
				.getModels(this.host.providerId)
				.every((model) => model.baseUrl !== undefined);
			const builtin = builtinDefaults(this.host.providerId).baseUrl !== undefined;
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

	dispose(): void {
		this.credential?.dispose();
	}

	hints(): string {
		if (this.edit.editing) {
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		}
		const back = keyHint("tui.select.cancel", "back");
		switch (this.rows()[this.index]) {
			case "credential":
				if (this.credential?.oauth) return [rawKeyHint("type", "to use an API key"), back].join("  ");
				return [rawKeyHint("type", "replace key"), keyHint("tui.select.confirm", "edit"), back].join("  ");
			case "logout":
				return [keyHint("tui.select.confirm", "log out"), back].join("  ");
			case "apiType":
			case "advanced":
				return [keyHint("tui.select.confirm", "open"), back].join("  ");
			default:
				return [rawKeyHint("type", "overwrite"), keyHint("tui.select.confirm", "edit"), back].join("  ");
		}
	}
}

/**
 * Single-select provider api sub-page of Authentication; Enter applies and
 * returns. Clearing is refused while any model still resolves its api from
 * the provider — set a model-level API under Model-specific API first.
 */
export function createProviderApiPane(host: ProviderPaneHost, initial?: string, onChosen?: () => void): EditorPane {
	const current = () => host.store.getProvider(host.providerId)?.api;
	return new ChoicePane<string | undefined>(host, "API Type", {
		current,
		initial,
		choices: () => {
			const fallback = builtinDefaults(host.providerId).api;
			const label = fallback ? `not set (built-in default: ${fallback})` : "not set (models define their own)";
			const values: (string | undefined)[] = [undefined, ...API_TYPES];
			const value = current();
			if (value && !values.includes(value)) values.push(value);
			return values.map((value) => ({
				value,
				label: value === undefined ? label : apiTypeLabel(value),
				dim: value === undefined,
			}));
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
			onChosen?.();
			return undefined;
		},
	});
}
