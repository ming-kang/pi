import { registerKeybindings } from "../../core/keybinding-registry.ts";
import { registerListKeybindings } from "../list-keybindings.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.provider.switchPaneLeft": true;
		"app.provider.switchPaneRight": true;
		"app.provider.removeEntry": true;
		"app.provider.checkAll": true;
	}
}

registerListKeybindings();
registerKeybindings({
	"app.provider.switchPaneLeft": { defaultKeys: "left", description: "/provider: focus the left pane" },
	"app.provider.switchPaneRight": { defaultKeys: "right", description: "/provider: focus the right pane" },
	"app.provider.removeEntry": {
		defaultKeys: "ctrl+x",
		description: "/provider: remove the selected model, compat entry, or dictionary entry",
	},
	"app.provider.checkAll": {
		defaultKeys: "ctrl+a",
		description: "/provider: check or uncheck every listed model in Fetch models",
	},
});
