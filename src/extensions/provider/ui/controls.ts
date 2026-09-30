/** Small reusable controls for provider panes; field policy stays with the caller. */
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { EditorHost, EditorPane } from "./pane.ts";
import { renderInfoLine, renderPlainLine, ValueEditor } from "./value-row.ts";

/** Returns the wrapped selection, or undefined when this was not a navigation key. */
export function moveSelection(
	keys: KeybindingsManager,
	data: string,
	index: number,
	count: number,
): number | undefined {
	const delta = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : undefined;
	return delta === undefined ? undefined : count === 0 ? 0 : (index + delta + count) % count;
}

export interface Choice<T> {
	label: string;
	value: T;
	dim?: boolean;
}

type ControlHost = Pick<EditorHost, "theme" | "keybindings" | "refresh" | "popPane">;
interface ChoiceOptions<T> {
	choices(): readonly Choice<T>[];
	current(): T;
	choose(value: T): string | undefined;
}

export class ChoicePane<T> implements EditorPane {
	readonly crumb: string;
	private readonly host: ControlHost;
	private readonly options: ChoiceOptions<T>;
	private index: number;
	private focused = false;
	private error: string | undefined;

	constructor(host: ControlHost, crumb: string, options: ChoiceOptions<T>) {
		this.host = host;
		this.crumb = crumb;
		this.options = options;
		this.index = Math.max(
			0,
			options.choices().findIndex((choice) => choice.value === options.current()),
		);
	}

	render(width: number): string[] {
		const lines = this.options.choices().map((choice, index) =>
			renderPlainLine(this.host.theme, `${choice.value === this.options.current() ? "●" : "○"} ${choice.label}`, {
				active: index === this.index,
				paneFocused: this.focused,
				dim: choice.dim,
				width,
			}),
		);
		if (this.error) lines.push(renderInfoLine(this.host.theme, this.error, width));
		return lines;
	}

	scrollWindow(): { cursor: number; bottom: number } {
		return { cursor: this.index, bottom: this.error ? 1 : 0 };
	}

	handleInput(data: string): void {
		const choices = this.options.choices();
		const next = moveSelection(this.host.keybindings, data, this.index, choices.length);
		if (next !== undefined) {
			this.index = next;
			this.host.refresh();
		} else if (this.host.keybindings.matches(data, "tui.select.cancel")) this.host.popPane();
		else if (
			this.host.keybindings.matches(data, "tui.select.confirm") ||
			this.host.keybindings.matches(data, "app.list.toggle")
		) {
			const choice = choices[this.index];
			if (!choice) return;
			this.error = this.options.choose(choice.value);
			if (this.error) this.host.refresh();
			else this.host.popPane();
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

/** Owns an inline edit's identity, input focus, validation error, and cancellation. */
export class InlineEdit<Key> {
	private readonly refresh: () => void;
	private active: { key: Key; editor: ValueEditor } | undefined;
	error: string | undefined;

	constructor(refresh: () => void) {
		this.refresh = refresh;
	}
	get editing(): boolean {
		return this.active !== undefined;
	}
	editor(key: Key): ValueEditor | undefined {
		return this.active?.key === key ? this.active.editor : undefined;
	}
	setFocused(focused: boolean): void {
		if (this.active) this.active.editor.focused = focused;
	}

	begin(
		key: Key,
		current: string,
		mode: "overwrite" | "tweak",
		focused: boolean,
		commit: (value: string) => string | undefined,
		firstData?: string,
	): void {
		const editor = new ValueEditor({
			onCommit: (value) => {
				this.error = commit(value);
				if (!this.error) this.active = undefined;
				this.refresh();
			},
			onCancel: () => {
				this.active = undefined;
				this.error = undefined;
				this.refresh();
			},
		});
		this.active = { key, editor };
		editor.focused = focused;
		if (mode === "overwrite") editor.beginOverwrite(firstData);
		else editor.beginTweak(current);
		this.refresh();
	}

	handleInput(data: string, keys: KeybindingsManager): boolean {
		if (!this.active) return false;
		if (!keys.matches(data, "tui.select.up") && !keys.matches(data, "tui.select.down"))
			this.active.editor.handleInput(data);
		this.refresh();
		return true;
	}
}
