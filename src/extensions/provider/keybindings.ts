import { registerKeybindings } from "../../core/keybinding-registry.ts";
import { registerListKeybindings } from "../list-keybindings.ts";

declare module "../../core/keybindings.ts" {
	interface AppKeybindings {
		"app.provider.switchPaneLeft": true;
		"app.provider.switchPaneRight": true;
		"app.provider.removeEntry": true;
	}
}

registerListKeybindings();
registerKeybindings({
	"app.provider.switchPaneLeft": { defaultKeys: "left", description: "/provider: focus the left pane" },
	"app.provider.switchPaneRight": { defaultKeys: "right", description: "/provider: focus the right pane" },
	"app.provider.removeEntry": {
		defaultKeys: "ctrl+x",
		description: "/provider: remove the selected compat or dictionary entry",
	},
});
