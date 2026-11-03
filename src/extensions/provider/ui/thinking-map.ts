/** The seven thinking levels, each Custom (a provider effort string), Default, or Hidden (null). */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { THINKING_LEVELS } from "../constants.ts";
import { DELETE } from "../store.ts";
import { InlineEdit, moveSelection } from "./controls.ts";
import type { EditorPane, ModelHandle, PaneHost } from "./pane.ts";
import { isPrintableInput, renderErrorLines, renderInfoLine, renderKeyValueLine } from "./value-row.ts";

/** A level's three states, in the order the choice rows show them. */
const STATES = ["custom", "default", "hidden"] as const;
type State = (typeof STATES)[number];
type Mapping = string | null | undefined;

function stateOf(value: Mapping): State {
	return value === undefined ? "default" : value === null ? "hidden" : "custom";
}

/**
 * Levels list → one level's three choices. Custom edits its effort inline on
 * its own row (Enter or typing), as id and name do on the model page; Default
 * removes the key and Hidden writes null. On a built-in model the state is the
 * override's own key, and Default names the catalog value it restores.
 */
export class ThinkingMapPane implements EditorPane {
	readonly crumb = "thinkingLevelMap";
	private level: ModelThinkingLevel | undefined;
	private index = 0;
	private focused = false;
	private readonly edit: InlineEdit<"custom">;
	private readonly host: PaneHost;
	private readonly model: ModelHandle;

	constructor(host: PaneHost, model: ModelHandle) {
		this.host = host;
		this.model = model;
		this.edit = new InlineEdit(() => host.refresh());
	}

	/** What this pane writes: the override's own map on a built-in model, else the model's map. */
	private own(level: ModelThinkingLevel): Mapping {
		return this.model.own().thinkingLevelMap?.[level];
	}

	/** The catalog mapping that Default restores on a built-in model. */
	private builtin(level: ModelThinkingLevel): Mapping {
		return this.model.base()?.thinkingLevelMap?.[level];
	}

	private get inherits(): boolean {
		return this.model.base() !== undefined;
	}

	private describe(value: Mapping): string {
		return value === undefined ? "Default" : value === null ? "Hidden" : value;
	}

	private set(level: ModelThinkingLevel, value: string | null | typeof DELETE): void {
		this.model.setField(["thinkingLevelMap", level], value);
		this.index = THINKING_LEVELS.indexOf(level);
		this.level = undefined;
		this.host.refresh();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.model.read().reasoning !== true) {
			lines.push(renderInfoLine(this.host.theme, "reasoning is not true, so this map has no effect yet.", width));
		}
		return [...lines, ...(this.level ? this.renderStates(this.level, width) : this.renderLevels(width))];
	}

	private renderLevels(width: number): string[] {
		return THINKING_LEVELS.map((level, rowIndex) => {
			const own = this.own(level);
			// On a built-in model an untouched level shows the catalog value it inherits, dimmed.
			const shown = own === undefined ? this.builtin(level) : own;
			return renderKeyValueLine(this.host.theme, {
				keyLabel: level,
				valueText: this.describe(shown),
				unset: own === undefined,
				note: this.inherits && own !== undefined ? "· overridden" : undefined,
				active: rowIndex === this.index,
				paneFocused: this.focused,
				width,
			});
		});
	}

	private renderStates(level: ModelThinkingLevel, width: number): string[] {
		const theme = this.host.theme;
		const own = this.own(level);
		const builtin = this.builtin(level);
		// "removes …" only when Default would actually remove something.
		const removes = own === undefined ? "" : ", removes the override";
		const notes: Record<Exclude<State, "custom">, string> = {
			default: this.inherits
				? `· built-in: ${builtin === undefined ? "not mapped" : this.describe(builtin)}${removes}`
				: "· key omitted, Pi's default applies",
			hidden: "· null, hidden from the thinking selector",
		};
		const lines = [renderInfoLine(theme, `${level} · ● marks the current setting`, width)];
		for (const [rowIndex, state] of STATES.entries()) {
			const mark = state === stateOf(own) ? "●" : "○";
			const row = { active: rowIndex === this.index, paneFocused: this.focused, width };
			lines.push(
				state === "custom"
					? renderKeyValueLine(theme, {
							keyLabel: `${mark} Custom`,
							valueText: typeof own === "string" ? own : "type a provider effort",
							unset: typeof own !== "string",
							editing: this.edit.editor("custom"),
							...row,
						})
					: renderKeyValueLine(theme, {
							valueText: `${mark} ${state === "default" ? "Default" : "Hidden"}`,
							note: notes[state],
							...row,
						}),
			);
		}
		if (this.edit.error) lines.push(...renderErrorLines(theme, this.edit.error, width));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const level = this.level;
		const count = level ? STATES.length : THINKING_LEVELS.length;
		const next = moveSelection(kb, data, this.index, count);
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (!level) {
				this.host.popPane();
				return;
			}
			this.index = THINKING_LEVELS.indexOf(level);
			this.level = undefined;
			this.host.refresh();
			return;
		}
		if (!level) {
			if (kb.matches(data, "tui.select.confirm")) {
				const chosen = THINKING_LEVELS[this.index]!;
				this.level = chosen;
				this.index = STATES.indexOf(stateOf(this.own(chosen)));
				this.host.refresh();
			}
			return;
		}
		const state = STATES[this.index]!;
		if (state === "custom" && (kb.matches(data, "tui.select.confirm") || isPrintableInput(data))) {
			// Tweaking starts from the value in effect, the catalog's when nothing is overridden.
			const own = this.own(level);
			const current = own === undefined ? this.builtin(level) : own;
			const typed = isPrintableInput(data);
			this.edit.begin(
				"custom",
				typeof current === "string" ? current : "",
				typed ? "overwrite" : "tweak",
				this.focused,
				(value) => {
					const effort = value.trim();
					if (!effort) return "Type a provider effort, e.g. high; choose Hidden for null.";
					this.set(level, effort);
					return undefined;
				},
				typed ? data : undefined,
			);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) this.set(level, state === "hidden" ? null : DELETE);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.edit.setFocused(focused);
	}

	isEditing(): boolean {
		return this.edit.editing;
	}

	hints(): string {
		const back = keyHint("tui.select.cancel", "back");
		if (this.edit.editing)
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		if (!this.level) return [rawKeyHint("↑↓", "navigate"), keyHint("tui.select.confirm", "choose"), back].join("  ");
		if (STATES[this.index] === "custom")
			return [rawKeyHint("type", "overwrite"), keyHint("tui.select.confirm", "edit"), back].join("  ");
		return [rawKeyHint("↑↓", "navigate"), keyHint("tui.select.confirm", "set"), back].join("  ");
	}
}
