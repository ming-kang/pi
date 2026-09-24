import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { registerKeybindings } from "../../core/keybinding-registry.ts";

declare module "../../core/keybindings.ts" {
	interface AppKeybindings {
		"app.backgroundTasks.detach": true;
		"app.backgroundTasks.focusList": true;
		"app.backgroundTasks.focusPreview": true;
		"app.backgroundTasks.kill": true;
	}
}

registerKeybindings({
	"app.backgroundTasks.detach": {
		defaultKeys: "ctrl+b",
		description: "Move foreground Bash and Subagent executions to the background",
	},
	"app.backgroundTasks.focusList": { defaultKeys: "left", description: "Focus the background task list" },
	"app.backgroundTasks.focusPreview": { defaultKeys: "right", description: "Focus the background task preview" },
	"app.backgroundTasks.kill": { defaultKeys: "k", description: "Kill selected background task" },
	// Detach takes ctrl+b, which the editor otherwise binds as a second cursor-left key.
	"tui.editor.cursorLeft": { ...TUI_KEYBINDINGS["tui.editor.cursorLeft"], defaultKeys: "left" },
});
