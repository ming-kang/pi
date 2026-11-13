/** Small reusable controls for provider panes; field policy stays with the caller. */
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { EditorPane, PaneHost } from "./pane.ts";
import { renderInfoLine, renderPlainLine, renderSearchLine, type ScrollWindowInfo, ValueEditor } from "./value-row.ts";

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
	/** Dim text after the label, e.g. what the option stands for. */
	note?: string;
}

type ControlHost = Pick<PaneHost, "theme" | "keybindings" | "refresh" | "popPane">;
interface ChoiceOptions<T> {
	/** Optional dim header line pinned above the choices. */
	header?: string;
	choices(): readonly Choice<T>[];
	current(): T;
	/** Highlighted on open instead of the current value, e.g. where a first-time pick starts. */
	initial?: T;
	choose(value: T): string | undefined;
	/** Runs after this pane pops following a successful choice (e.g. to push a nested picker). */
	afterChoose?(value: T): void;
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
			options.choices().findIndex((choice) => choice.value === (options.initial ?? options.current())),
		);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.options.header) lines.push(renderInfoLine(this.host.theme, this.options.header, width));
		for (const [index, choice] of this.options.choices().entries()) {
			lines.push(
				renderPlainLine(this.host.theme, `${choice.value === this.options.current() ? "●" : "○"} ${choice.label}`, {
					active: index === this.index,
					paneFocused: this.focused,
					dim: choice.dim,
					note: choice.note,
					width,
				}),
			);
		}
		if (this.error) lines.push(renderInfoLine(this.host.theme, this.error, width));
		return lines;
	}

	scrollWindow(): { top: number; cursor: number; bottom: number } {
		const top = this.options.header ? 1 : 0;
		return { top, cursor: top + this.index, bottom: this.error ? 1 : 0 };
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
			if (this.error) {
				this.host.refresh();
			} else {
				this.host.popPane();
				this.options.afterChoose?.(choice.value);
			}
		}
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}
	hints(): string {
		return [
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "select"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

export interface FilterListOptions<T> {
	readonly crumb?: string;
	readonly initialQuery?: string;
	items(query: string): readonly T[];
	renderItem(item: T, state: { active: boolean; focused: boolean; width: number }): string;
	readonly emptyMessage: string;
	/** Optional dim info lines pinned below the list. */
	footer?(items: readonly T[]): readonly string[];
	readonly confirmVerb: string;
	readonly searchVerb?: string;
	onConfirm(item: T): void;
}

/** Searchable single-select pane managing query editing, selection clamping/reset, and windowing. */
export class FilterListPane<T> implements EditorPane {
	readonly crumb?: string;
	protected readonly host: ControlHost;
	private readonly options: FilterListOptions<T>;
	private readonly search: ValueEditor;
	private index = 0;
	private focused = false;
	private bottomLines = 0;

	constructor(host: ControlHost, options: FilterListOptions<T>) {
		this.host = host;
		this.options = options;
		this.crumb = options.crumb;
		this.search = new ValueEditor({
			onCommit: () => this.confirmCurrent(),
			onCancel: () => this.host.popPane(),
		});
		if (options.initialQuery) this.search.reset(options.initialQuery);
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const entries = this.options.items(this.search.value);
		this.index = Math.min(this.index, Math.max(0, entries.length - 1));
		const lines: string[] = [renderSearchLine(theme, this.search, this.focused, width)];
		for (const [row, item] of entries.entries()) {
			lines.push(this.options.renderItem(item, { active: row === this.index, focused: this.focused, width }));
		}
		let bottom = 0;
		if (entries.length === 0) {
			lines.push(renderInfoLine(theme, this.options.emptyMessage, width));
			bottom++;
		}
		for (const text of this.options.footer?.(entries) ?? []) {
			lines.push(renderInfoLine(theme, text, width));
			bottom++;
		}
		this.bottomLines = bottom;
		return lines;
	}

	scrollWindow(): ScrollWindowInfo {
		return { top: 1, bottom: this.bottomLines, cursor: 1 + this.index };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const entries = this.options.items(this.search.value);
		const next = moveSelection(kb, data, this.index, entries.length);
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
			this.confirmCurrent();
			return;
		}
		const previous = this.search.value;
		this.search.handleInput(data);
		if (this.search.value !== previous) this.index = 0;
		this.host.refresh();
	}

	private confirmCurrent(): void {
		const item = this.options.items(this.search.value)[this.index];
		if (item !== undefined) this.options.onConfirm(item);
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.search.focused = focused;
	}

	isEditing(): boolean {
		return true; // the filter input always owns ←/→
	}

	hints(): string {
		return [
			rawKeyHint("type", this.options.searchVerb ?? "filter"),
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", this.options.confirmVerb),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}

/** Owns an inline edit's identity, input focus, validation error, and cancellation. */
export class InlineEdit<Key> {
	private readonly refresh: () => void;
	private active: { key: Key; editor: ValueEditor } | undefined;
	private disposed = false;
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
	dispose(): void {
		this.disposed = true;
	}

	begin(
		key: Key,
		current: string,
		mode: "overwrite" | "tweak",
		focused: boolean,
		commit: (value: string) => string | undefined | Promise<string | undefined>,
		firstData?: string,
		extras: {
			placeholder?: string;
			placeholderStyle?: (text: string) => string;
			/** Runs after a successful commit closes the editor, e.g. to open the next field. */
			onDone?: () => void;
			/** Runs after Esc closes the editor without a value, e.g. when the field was an optional step. */
			onCancel?: () => void;
		} = {},
	): void {
		const finish = (err: string | undefined) => {
			this.error = err;
			if (!err) {
				this.active = undefined;
				extras.onDone?.();
			}
			this.refresh();
		};
		const editor = new ValueEditor({
			placeholder: extras.placeholder,
			placeholderStyle: extras.placeholderStyle,
			onCommit: (value) => {
				const result = commit(value);
				if (result && typeof result === "object" && "then" in result) {
					this.error = undefined;
					this.refresh();
					void result.then(
						(err) => {
							if (!this.disposed) finish(err);
						},
						(err: unknown) => {
							if (!this.disposed) finish(err instanceof Error ? err.message : String(err));
						},
					);
					return;
				}
				finish(result);
			},
			onCancel: () => {
				this.active = undefined;
				this.error = undefined;
				extras.onCancel?.();
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
