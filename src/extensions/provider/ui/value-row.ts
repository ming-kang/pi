/**
 * Shared row machinery for /provider right-column panes.
 *
 * Fixed-key rows always render `Key: Value`; the key and colon are never
 * editable, but the whole row highlights when selected. Value editing uses
 * pi-tui's Input: typing starts an overwrite, Enter starts a tweak with the
 * old value, Esc restores.
 */

import { decodeKittyPrintable, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

export const CURSOR = "›";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Wraps pi-tui Input with the two /provider entry modes. */
export class ValueEditor {
	private readonly input: Input;

	constructor(callbacks: {
		/** Enter pressed; the pane validates and either closes the editor or keeps it open with an error. */
		onCommit: (value: string) => void;
		/** Esc pressed; the pane discards the in-progress value. */
		onCancel: () => void;
	}) {
		this.input = new Input({ prompt: "" });
		this.input.onSubmit = callbacks.onCommit;
		this.input.onEscape = callbacks.onCancel;
	}

	/** Start with an empty value; optional first input (the character/paste that opened the editor). */
	beginOverwrite(firstData?: string): void {
		this.input.setValue("");
		if (firstData) this.input.handleInput(firstData);
	}

	/** Reset the text without any editing semantics (search boxes, repurposed inputs). */
	reset(value: string): void {
		this.beginTweak(value);
	}

	/** Start with the current value and the cursor at the end. */
	beginTweak(current: string): void {
		// Native paste insertion positions the cursor without synthesizing a user-bound key.
		this.input.setValue("");
		this.input.handleInput(PASTE_START + current + PASTE_END);
		// Preserve existing values verbatim even when they contain paste-normalized whitespace.
		this.input.setValue(current);
	}

	get value(): string {
		return this.input.getValue();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	renderLine(width: number): string {
		return this.input.render(Math.max(1, width))[0] ?? "";
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}
}

export interface KeyValueLineOptions {
	/** Fixed key label, rendered as `key: `; omitted for free-form lines. */
	keyLabel?: string;
	/** Current value display (already masked/truncated by the caller as needed). */
	valueText?: string;
	/** Value is unset and the text shows a default/inherited fallback. */
	unset?: boolean;
	/** Row is the pane's cursor row. */
	active: boolean;
	/** The pane holding this row currently has keyboard focus. */
	paneFocused: boolean;
	/** When set, the row renders the editor in place of the value. */
	editing?: ValueEditor;
	/** Extra dim note after the value, e.g. `· draft`. */
	note?: string;
	width: number;
}

/**
 * Render one `key: value` row. The active row highlights key, colon, and
 * value together (accent when the pane is focused, muted otherwise); unset
 * fallback values stay dim even on the active row.
 */
export function renderKeyValueLine(theme: Theme, opts: KeyValueLineOptions): string {
	const marker = opts.active ? `${CURSOR} ` : "  ";
	const keyPrefix = opts.keyLabel === undefined ? "" : `${opts.keyLabel}: `;
	const color = opts.paneFocused ? "accent" : "muted";
	const note = opts.note ? theme.fg("dim", ` ${opts.note}`) : "";
	if (opts.editing) {
		const head = (opts.active ? theme.fg(color, marker) : marker) + theme.fg(opts.active ? color : "text", keyPrefix);
		const body = opts.editing.renderLine(Math.max(1, opts.width - visibleWidth(marker) - visibleWidth(keyPrefix)));
		return truncateToWidth(head + theme.fg(opts.active ? color : "text", body) + note, opts.width);
	}
	const valueColor = opts.unset ? "dim" : opts.active ? color : "text";
	const line =
		(opts.active ? theme.fg(color, marker) : marker) +
		theme.fg(opts.active ? color : "text", keyPrefix) +
		theme.fg(valueColor, opts.valueText ?? "") +
		note;
	return truncateToWidth(line, opts.width);
}

export interface PlainLineOptions {
	active?: boolean;
	paneFocused?: boolean;
	dim?: boolean;
	/** Checkbox mark; renders `[x] ` / `[ ] ` before the text. */
	checked?: boolean;
	note?: string;
	width: number;
}

/** Render a non-key row: action rows, checkboxes, radio options, hints. */
export function renderPlainLine(theme: Theme, text: string, opts: PlainLineOptions): string {
	const marker = opts.active ? `${CURSOR} ` : "  ";
	const check = opts.checked === undefined ? "" : opts.checked ? "[x] " : "[ ] ";
	const color = opts.dim ? "dim" : opts.active ? (opts.paneFocused ? "accent" : "muted") : "text";
	const note = opts.note ? theme.fg("dim", ` ${opts.note}`) : "";
	const line = (opts.active ? theme.fg(color, marker) : marker) + theme.fg(color, check + text) + note;
	return truncateToWidth(line, opts.width);
}

/** Dim informational line without a cursor slot. */
export function renderInfoLine(theme: Theme, text: string, width: number): string {
	return truncateToWidth(theme.fg("dim", text), width);
}

/** True for printable text input (single chars or pasted text), false for key events and control sequences. */
export function isPrintableInput(data: string): boolean {
	if (!data) return false;
	if (data.startsWith(PASTE_START) || decodeKittyPrintable(data) !== undefined) return true;
	if (data.includes("\x1b") || data.includes("\r") || data.includes("\n")) return false;
	for (const char of data) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** Width-aware middle ellipsis for long identifiers: keeps the head and the tail. */
export function truncateMiddle(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 4) return truncateToWidth(text, maxWidth);
	const headWidth = Math.ceil((maxWidth - 1) / 2);
	const tailWidth = maxWidth - 1 - headWidth;
	let head = "";
	let headUsed = 0;
	for (const char of text) {
		const charWidth = visibleWidth(char);
		if (headUsed + charWidth > headWidth) break;
		head += char;
		headUsed += charWidth;
	}
	let tail = "";
	let tailUsed = 0;
	for (const char of [...text].reverse()) {
		const charWidth = visibleWidth(char);
		if (tailUsed + charWidth > tailWidth) break;
		tail = char + tail;
		tailUsed += charWidth;
	}
	return `${head}…${tail}`;
}
