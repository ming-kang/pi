import type { KeybindingDefinition, KeybindingDefinitions } from "@earendil-works/pi-tui";

const registered: KeybindingDefinitions = {};

function sameDefinition(left: KeybindingDefinition, right: KeybindingDefinition): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Declare configurable keybindings owned outside core. Bundled extensions call this when
 * their module loads, before any KeybindingsManager is created, and augment AppKeybindings
 * for the ids they add. A definition may also override a built-in default the extension's
 * binding displaces. Registering an id twice requires the same definition.
 */
export function registerKeybindings(definitions: KeybindingDefinitions): void {
	for (const [id, definition] of Object.entries(definitions)) {
		const existing = registered[id];
		if (existing && !sameDefinition(existing, definition)) {
			throw new Error(`Keybinding ${id} is already registered with a different definition`);
		}
		registered[id] = definition;
	}
}

/** Definitions registered so far, applied over the built-in KEYBINDINGS. */
export function getRegisteredKeybindings(): KeybindingDefinitions {
	return { ...registered };
}
