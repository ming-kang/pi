import { registerKeybindings } from "../../core/keybinding-registry.ts";

declare module "../../core/keybindings.ts" {
	interface AppKeybindings {
		"app.btw.close": true;
		"app.btw.cancel": true;
		"app.btw.scrollUp": true;
		"app.btw.scrollDown": true;
	}
}

registerKeybindings({
	"app.btw.close": { defaultKeys: "escape", description: "Close the BTW conversation" },
	"app.btw.cancel": { defaultKeys: "ctrl+c", description: "Stop the BTW answer, or close when idle" },
	"app.btw.scrollUp": { defaultKeys: "up", description: "Scroll BTW up when the editor is empty" },
	"app.btw.scrollDown": { defaultKeys: "down", description: "Scroll BTW down when the editor is empty" },
});
