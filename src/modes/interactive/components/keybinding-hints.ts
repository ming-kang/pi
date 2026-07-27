/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeybindingsManager, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

function formatKeyLabelPart(part: string): string {
	const normalized = part.toLowerCase();
	switch (normalized) {
		case "alt":
			return process.platform === "darwin" ? "Option" : "Alt";
		case "ctrl":
			return "Ctrl";
		case "shift":
			return "Shift";
		case "escape":
		case "esc":
			return "Esc";
		case "enter":
		case "return":
			return "Enter";
		case "space":
			return "Space";
		case "tab":
			return "Tab";
		case "left":
			return "←";
		case "right":
			return "→";
		case "up":
			return "↑";
		case "down":
			return "↓";
		case "pageup":
			return "PgUp";
		case "pagedown":
			return "PgDn";
		default:
			return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
	}
}

/** Format one key id for compact UI labels without treating literal `/` or `+` keys as separators. */
export function formatKeyLabel(key: string): string {
	if (!key) return "";
	const modifiers: string[] = [];
	let remaining = key;
	while (true) {
		const match = /^(ctrl|shift|alt)\+/i.exec(remaining);
		if (!match) break;
		modifiers.push(formatKeyLabelPart(match[1]));
		remaining = remaining.slice(match[0].length);
	}
	const keyPart = formatKeyLabelPart(remaining || "+");
	return [...modifiers, keyPart].join("+");
}

export interface KeyLabelOptions {
	/** Use an injected manager for custom components instead of the global manager. */
	keybindings?: Pick<KeybindingsManager, "getKeys">;
	/** Display only when the action has no configured key. */
	fallback?: string;
}

/** Display the first configured key for a compact hint, with human-friendly names. */
export function keyLabel(keybinding: Keybinding, options: KeyLabelOptions = {}): string {
	const key = (options.keybindings ?? getKeybindings()).getKeys(keybinding)[0];
	return key !== undefined ? formatKeyLabel(key) : options.fallback ? formatKeyLabel(options.fallback) : "";
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
