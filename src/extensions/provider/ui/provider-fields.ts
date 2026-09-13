/** Provider connection and API settings panes. */

import type { ModelsJsonProvider } from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { builtinDefaults } from "../catalog.ts";
import { API_TYPES, maskApiKey, truncate } from "../constants.ts";
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

/** baseUrl / apiKey rows with masking and credential-source hints. */
export class AuthPane implements EditorPane {
	private readonly rows = ["baseUrl", "apiKey"] as const;
	private index = 0;
	private editing: ValueEditor | undefined;
	private editingRow: (typeof this.rows)[number] | undefined;
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
		// Two value rows scroll; the credential-source notes stay pinned below.
		return { cursor: this.index, bottom: this.bottomNoteCount() };
	}

	private bottomNoteCount(): number {
		const status = this.registry.getProviderAuthStatus(this.host.providerId);
		return (this.error ? 1 : 0) + (status.configured ? 1 : 0) + 1;
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
						valueText: value ?? "unset",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "baseUrl" ? this.editing : undefined,
						width,
					}),
				);
			} else {
				const value = provider?.apiKey;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: "apiKey",
						valueText: value ? maskApiKey(value) : "unset",
						unset: !value,
						active,
						paneFocused: this.focused,
						editing: this.editingRow === "apiKey" ? this.editing : undefined,
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
			this.beginEdit("tweak");
			return;
		}
		if (isPrintableInput(data)) {
			this.beginEdit("overwrite", data);
			return;
		}
	}

	private beginEdit(mode: "overwrite" | "tweak", firstData?: string): void {
		const row = this.rows[this.index]!;
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
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				this.error = "baseUrl must be a valid URL.";
				this.host.refresh();
				return;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				this.error = `Unsupported protocol: ${url.protocol}`;
				this.host.refresh();
				return;
			}
			if (url.username || url.password || url.hash) {
				this.error = "baseUrl must not contain credentials or a fragment.";
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
			keyHint("tui.select.confirm", "edit"),
			keyHint("app.provider.switchPaneLeft", "focus left"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/** Single-select provider api list; current value marked with ●. */
export class ApiTypePane implements EditorPane {
	private index = 0;
	private focused = false;
	private error: string | undefined;

	private readonly host: EditorHost;
	constructor(host: EditorHost) {
		this.host = host;

		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const options = this.options();
		this.index = Math.max(
			0,
			options.findIndex((option) => option === (current ?? UNSET)),
		);
	}

	private options(): string[] {
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const base: string[] = [UNSET, ...API_TYPES];
		if (current && !(API_TYPES as readonly string[]).includes(current)) base.push(current);
		return base;
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const current = this.host.store.getProvider(this.host.providerId)?.api;
		const lines = this.options().map((option, rowIndex) => {
			const active = rowIndex === this.index;
			const selected = option === UNSET ? current === undefined : current === option;
			const label = `${selected ? "●" : "○"} ${option === UNSET ? "unset (models must define api)" : option}`;
			return renderPlainLine(theme, label, { active, paneFocused: this.focused, dim: option === UNSET, width });
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
			const option = options[this.index]!;
			const firstModel = this.host.store.getModels(this.host.providerId)[0];
			if (
				option === UNSET &&
				firstModel &&
				!firstModel.api &&
				!builtinDefaults(this.host.providerId, firstModel.id).api
			) {
				this.error = "Models rely on this API; configure a model-level API before clearing it.";
				this.host.refresh();
				return;
			}
			this.error = undefined;
			this.host.mutate(() =>
				this.host.store.setProviderField(this.host.providerId, ["api"], option === UNSET ? DELETE : option),
			);
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	hints(): string {
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "select"),
			keyHint("app.provider.switchPaneLeft", "focus left"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

const UNSET = "(unset)";
