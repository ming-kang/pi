import { registerKeybindings } from "../core/keybinding-registry.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.list.toggle": true;
	}
}

/** Multi-select lists shared by bundled extensions (Question and /provider). */
export function registerListKeybindings(): void {
	registerKeybindings({
		"app.list.toggle": { defaultKeys: "space", description: "Toggle selected list item" },
	});
}
