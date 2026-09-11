/**
 * Fetch Models pane: idle intro → cancellable loading → error / searchable
 * checklist of the remote catalog. Already-configured ids are marked "Added"
 * and cannot be checked; importing appends new {id, name?} entries, saves
 * once, and refreshes the provider immediately.
 */

import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { truncate } from "../constants.ts";
import type { ProbeModel } from "../probe.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { renderInfoLine, renderPlainLine, ValueEditor } from "./value-row.ts";

const MAX_VISIBLE = 10;

type FetchState =
	| { type: "idle" }
	| { type: "loading" }
	| { type: "error"; message: string }
	| { type: "results"; models: ProbeModel[]; truncated: boolean };

export class FetchModelsPane implements EditorPane {
	readonly crumb = "Fetch Models";
	private state: FetchState = { type: "idle" };
	private controller: AbortController | undefined;
	private search: ValueEditor;
	private query = "";
	private index = 0;
	private checked = new Set<string>();
	private importing = false;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	constructor(host: EditorHost) {
		this.host = host;

		this.search = new ValueEditor(host.keybindings, {
			onCommit: () => this.importChecked(),
			onCancel: () => this.exitResults(),
		});
	}

	/** Enter pressed on the left-column row (or on the idle pane): start the request. */
	start(): void {
		if (this.state.type === "loading" || this.importing) return;
		const controller = new AbortController();
		this.controller = controller;
		this.state = { type: "loading" };
		this.error = undefined;
		this.host.refresh();
		void this.host
			.runFetch(controller.signal)
			.then((result) => {
				if (controller.signal.aborted || this.state.type !== "loading") return; // stale page/result
				if (!result.ok) {
					if (result.error === "Cancelled.") return;
					this.state = { type: "error", message: result.error };
					this.host.setFetchStatus("· failed");
				} else {
					this.state = { type: "results", models: result.models, truncated: result.truncated };
					this.checked = new Set();
					this.query = "";
					this.search.reset("");
					this.index = 0;
				}
				this.host.refresh();
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				this.state = { type: "error", message: error instanceof Error ? error.message : String(error) };
				this.host.setFetchStatus("· failed");
				this.host.refresh();
			});
	}

	private existingIds(): Set<string> {
		return new Set(this.host.store.getModels(this.host.providerId).map((model) => model.id));
	}

	private rows(): { model: ProbeModel; added: boolean }[] {
		if (this.state.type !== "results") return [];
		const existing = this.existingIds();
		const rows = this.state.models.map((model) => ({ model, added: existing.has(model.id) }));
		const query = this.query.trim().toLowerCase();
		if (!query) return rows;
		return rows.filter(
			(row) => row.model.id.toLowerCase().includes(query) || row.model.name?.toLowerCase().includes(query),
		);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const baseUrl = this.host.store.getProvider(this.host.providerId)?.baseUrl;
		switch (this.state.type) {
			case "idle":
				return [
					renderInfoLine(
						theme,
						baseUrl ? `Fetch the model catalog from ${baseUrl}` : "Set a baseUrl under Authentication first.",
						width,
					),
					renderInfoLine(
						theme,
						"OpenAI-style GET {baseUrl}/models with a data[] list; the auth header follows the API type (Bearer, x-api-key, …).",
						width,
					),
				];
			case "loading":
				return [
					renderInfoLine(theme, `Fetching ${baseUrl ?? ""}/models …`, width),
					renderInfoLine(theme, "Esc cancels the request.", width),
				];
			case "error":
				return [
					theme.fg("error", truncate(this.state.message, Math.max(10, width - 2))),
					renderInfoLine(theme, "Enter retries; Esc goes back.", width),
				];
			case "results": {
				const lines: string[] = [];
				if (this.state.truncated) {
					lines.push(
						renderInfoLine(theme, "The catalog was truncated; refine manually if a model is missing.", width),
					);
				}
				lines.push(this.search.renderLine(width));
				const rows = this.rows();
				const start = Math.max(
					0,
					Math.min(this.index - Math.floor(MAX_VISIBLE / 2), Math.max(0, rows.length - MAX_VISIBLE)),
				);
				const end = Math.min(start + MAX_VISIBLE, rows.length);
				for (let rowIndex = start; rowIndex < end; rowIndex++) {
					const row = rows[rowIndex]!;
					if (row.added) {
						lines.push(
							renderPlainLine(theme, row.model.id, {
								active: rowIndex === this.index,
								paneFocused: this.focused,
								dim: true,
								note: "· Added",
								width,
							}),
						);
						continue;
					}
					lines.push(
						renderPlainLine(theme, row.model.name ? `${row.model.id} · ${row.model.name}` : row.model.id, {
							checked: this.checked.has(row.model.id),
							active: rowIndex === this.index,
							paneFocused: this.focused,
							width,
						}),
					);
				}
				if (rows.length === 0) lines.push(renderInfoLine(theme, "No matching models.", width));
				const addedCount = rows.filter((row) => row.added).length;
				lines.push(
					renderInfoLine(
						theme,
						`${this.checked.size} selected · ${rows.length} shown${addedCount ? ` · ${addedCount} already added` : ""}`,
						width,
					),
				);
				if (this.importing) lines.push(renderInfoLine(theme, "Importing…", width));
				if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
				return lines;
			}
		}
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		switch (this.state.type) {
			case "idle":
				if (kb.matches(data, "tui.select.confirm")) {
					this.start();
					return;
				}
				if (kb.matches(data, "tui.select.cancel")) {
					this.host.popPane();
					return;
				}
				return;
			case "loading":
				if (kb.matches(data, "tui.select.cancel")) {
					this.controller?.abort();
					this.state = { type: "idle" };
					this.host.refresh();
					return;
				}
				return;
			case "error":
				if (kb.matches(data, "tui.select.confirm")) {
					this.start();
					return;
				}
				if (kb.matches(data, "tui.select.cancel")) {
					this.host.popPane();
					return;
				}
				return;
			case "results":
				this.handleResultsInput(data);
				return;
		}
	}

	private handleResultsInput(data: string): void {
		const kb = this.host.keybindings;
		const rows = this.rows();
		if (kb.matches(data, "tui.select.up")) {
			if (rows.length > 0) this.index = this.index === 0 ? rows.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (rows.length > 0) this.index = (this.index + 1) % rows.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "app.list.toggle")) {
			const row = rows[this.index];
			if (!row || row.added || this.importing) return;
			if (this.checked.has(row.model.id)) this.checked.delete(row.model.id);
			else this.checked.add(row.model.id);
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.exitResults();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.importChecked();
			return;
		}
		const before = this.query;
		this.search.handleInput(data);
		this.query = this.search.value;
		if (this.query !== before) this.index = 0;
		this.host.refresh();
	}

	private importChecked(): void {
		if (this.state.type !== "results" || this.importing) return;
		if (this.checked.size === 0) {
			this.exitResults();
			return;
		}
		const chosen = this.state.models.filter((model) => this.checked.has(model.id));
		this.importing = true;
		this.error = undefined;
		this.host.refresh();
		void this.host
			.importModels(chosen)
			.then((error) => {
				this.importing = false;
				if (error) {
					this.error = error;
					this.host.setFetchStatus("· import failed");
					return this.host.refresh();
				}
				this.host.setFetchStatus(`· ${this.host.store.getModels(this.host.providerId).length} models`);
				this.state = { type: "idle" };
				this.host.popPane(); // back to the left column with the new models visible
			})
			.catch((error: unknown) => {
				this.importing = false;
				this.error = error instanceof Error ? error.message : String(error);
				this.host.refresh();
			});
	}

	private exitResults(): void {
		this.state = { type: "idle" };
		this.checked = new Set();
		this.host.popPane();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.search.focused = focused && this.state.type === "results";
	}

	isEditing(): boolean {
		return this.state.type === "results"; // the filter input owns ←/→
	}

	dispose(): void {
		this.controller?.abort();
	}

	hints(): string {
		switch (this.state.type) {
			case "loading":
				return keyHint("tui.select.cancel", "cancel request");
			case "results":
				return [
					rawKeyHint("type", "filter"),
					keyHint("app.list.toggle", "check"),
					keyHint("tui.select.confirm", "import"),
					keyHint("tui.select.cancel", "discard"),
				].join("  ");
			case "error":
				return [keyHint("tui.select.confirm", "retry"), keyHint("tui.select.cancel", "back")].join("  ");
			default:
				return [keyHint("tui.select.confirm", "fetch"), keyHint("tui.select.cancel", "back")].join("  ");
		}
	}
}
