import type { Keybinding, KeybindingDefinition, KeybindingDefinitions } from "@earendil-works/pi-tui";

export interface KeybindingHelpRow {
	action: Keybinding;
	description: string;
}

export interface KeybindingHelpSection {
	id: string;
	title: string;
	rows: readonly KeybindingHelpRow[];
}

const registered: KeybindingDefinitions = {};
const reserved = new Set<Keybinding>();
const helpSections = new Map<string, KeybindingHelpSection>();

function sameDefinition(left: KeybindingDefinition, right: KeybindingDefinition): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Declare configurable keybindings owned outside core. Bundled extensions call this when
 * their module loads, before any KeybindingsManager is created, and augment the pi-tui
 * Keybindings interface for the ids they add. A definition may also override a built-in
 * default the extension's binding displaces. Registering an id twice requires the same
 * definition.
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

/** Reserve editor-global bindings against ordinary extension shortcuts. */
export function registerReservedKeybindings(...actions: Keybinding[]): void {
	for (const action of actions) reserved.add(action);
}

export function getReservedKeybindings(): ReadonlySet<Keybinding> {
	return reserved;
}

/** Register a feature-owned section in the interactive keyboard help. */
export function registerKeybindingHelpSection(section: KeybindingHelpSection): void {
	const existing = helpSections.get(section.id);
	if (existing && JSON.stringify(existing) !== JSON.stringify(section))
		throw new Error(`Keybinding help section ${section.id} is already registered with different content`);
	helpSections.set(section.id, section);
}

export function getRegisteredKeybindingHelpSections(): readonly KeybindingHelpSection[] {
	return [...helpSections.values()];
}
