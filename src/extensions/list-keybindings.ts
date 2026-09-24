import { registerKeybindings } from "../core/keybinding-registry.ts";

declare module "../core/keybindings.ts" {
	interface AppKeybindings {
		"app.list.toggle": true;
	}
}

/** Multi-select lists shared by bundled extensions (Question and /provider). */
export function registerListKeybindings(): void {
	registerKeybindings({
		"app.list.toggle": { defaultKeys: "space", description: "Toggle selected list item" },
	});
}
