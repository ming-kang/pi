/** The seven thinking levels and their inherited, hidden, or string mappings. */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { THINKING_LEVELS, truncate } from "../constants.ts";
import { DELETE } from "../store.ts";
import type { EditorHost, EditorPane, ModelHandle } from "./pane.ts";
import { renderInfoLine, renderKeyValueLine, renderPlainLine, ValueEditor } from "./value-row.ts";

// -------------------------------------------------------------------------
// thinkingLevelMap
// -------------------------------------------------------------------------

type ThinkingMapMode =
	| { type: "levels" }
	| { type: "choice"; level: ModelThinkingLevel; index: number }
	| { type: "target"; level: ModelThinkingLevel };

export class ThinkingMapPane implements EditorPane {
	readonly crumb = "thinkingLevelMap";
	private mode: ThinkingMapMode = { type: "levels" };
	private index = 0;
	private editor: ValueEditor | undefined;
	private error: string | undefined;
	private focused = false;

	private readonly host: EditorHost;
	private readonly model: ModelHandle;
	constructor(host: EditorHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
	}

	private map(): Partial<Record<ModelThinkingLevel, string | null>> {
		return this.model.read().thinkingLevelMap ?? {};
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines: string[] = [];
		if (this.model.read().reasoning !== true) {
			lines.push(
				renderInfoLine(theme, "reasoning is not true — the map is stored but currently has no effect.", width),
			);
		}
		if (this.mode.type === "levels") {
			for (const [rowIndex, level] of THINKING_LEVELS.entries()) {
				const value = this.map()[level];
				const status = value === undefined ? "default" : value === null ? "null (hidden)" : value;
				lines.push(
					renderKeyValueLine(theme, {
						keyLabel: level,
						valueText: status,
						unset: value === undefined,
						active: rowIndex === this.index,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		} else if (this.mode.type === "choice") {
			lines.push(renderInfoLine(theme, `${this.mode.level} · mapping`, width));
			for (const [choiceIndex, label] of [
				"String target (provider effort)",
				"Hidden (null)",
				"Default (remove key)",
			].entries()) {
				lines.push(
					renderPlainLine(theme, label, {
						active: choiceIndex === this.mode.index,
						paneFocused: this.focused,
						width,
					}),
				);
			}
		} else {
			lines.push(renderInfoLine(theme, `${this.mode.level} · non-empty provider effort`, width));
			lines.push(
				renderKeyValueLine(theme, {
					keyLabel: this.mode.level,
					active: true,
					paneFocused: this.focused,
					editing: this.editor,
					width,
				}),
			);
		}
		if (this.error) lines.push(theme.fg("error", truncate(this.error, Math.max(10, width - 2))));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.mode.type === "target") {
			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) return;
			this.editor?.handleInput(data);
			this.host.refresh();
			return;
		}
		if (this.mode.type === "choice") {
			if (kb.matches(data, "tui.select.up")) {
				this.mode = { ...this.mode, index: this.mode.index === 0 ? 2 : this.mode.index - 1 };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.mode = { ...this.mode, index: (this.mode.index + 1) % 3 };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.mode = { type: "levels" };
				this.host.refresh();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const { level, index } = this.mode;
				if (index === 0) {
					const editor = new ValueEditor({
						onCommit: (value) => {
							const target = value.trim();
							if (!target) {
								this.error = "A string target must be non-empty; use Hidden for null.";
								return this.host.refresh();
							}
							this.error = undefined;
							this.mode = { type: "levels" };
							this.editor = undefined;
							this.host.mutate(() => this.model.setField(["thinkingLevelMap", level], target));
						},
						onCancel: () => {
							this.editor = undefined;
							this.mode = { type: "levels" };
							this.host.refresh();
						},
					});
					this.editor = editor;
					editor.focused = this.focused;
					const existing = this.map()[level];
					if (typeof existing === "string") editor.beginTweak(existing);
					this.mode = { type: "target", level };
					this.host.refresh();
					return;
				}
				this.mode = { type: "levels" };
				this.host.mutate(() => this.model.setField(["thinkingLevelMap", level], index === 1 ? null : DELETE));
				return;
			}
			return;
		}
		// levels
		if (kb.matches(data, "tui.select.up")) {
			this.index = this.index === 0 ? THINKING_LEVELS.length - 1 : this.index - 1;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.index = (this.index + 1) % THINKING_LEVELS.length;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.mode = { type: "choice", level: THINKING_LEVELS[this.index]!, index: 0 };
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (this.editor) this.editor.focused = focused && this.mode.type === "target";
	}

	isEditing(): boolean {
		return this.mode.type === "target";
	}

	hints(): string {
		if (this.mode.type === "target")
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "back")].join("  ");
		return [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", this.mode.type === "choice" ? "set" : "edit"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
