import {
	registerKeybindingHelpSection,
	registerKeybindings,
	registerReservedKeybindings,
} from "../../core/keybinding-registry.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.tasks.detach": true;
		"app.tasks.previousTab": true;
		"app.tasks.nextTab": true;
		"app.tasks.kill": true;
		"app.tasks.confirmStop": true;
		"app.tasks.detachSelected": true;
		"app.tasks.search": true;
		"app.tasks.follow": true;
		"app.tasks.top": true;
		"app.tasks.bottom": true;
		"app.tasks.nextFocus": true;
		"app.tasks.previousFocus": true;
		"app.tasks.help": true;
	}
}

const TASK_KEYBINDINGS = {
	"app.tasks.detach": { defaultKeys: "ctrl+b", description: "Move foreground tasks to the background" },
	"app.tasks.previousTab": { defaultKeys: "left", description: "Show Output in the focused task inspector" },
	"app.tasks.nextTab": { defaultKeys: "right", description: "Show Details in the focused task inspector" },
	"app.tasks.kill": { defaultKeys: "k", description: "Stop the selected task" },
	"app.tasks.confirmStop": { defaultKeys: "enter", description: "Confirm stopping the selected task" },
	"app.tasks.detachSelected": { defaultKeys: "b", description: "Move the selected task to the background" },
	"app.tasks.search": { defaultKeys: "/", description: "Search retained task identities and labels" },
	"app.tasks.follow": { defaultKeys: "f", description: "Follow the selected task's output" },
	"app.tasks.top": { defaultKeys: "home", description: "Go to the top of the task list or preview" },
	"app.tasks.bottom": { defaultKeys: "end", description: "Go to the bottom of the task list or preview" },
	"app.tasks.nextFocus": { defaultKeys: "tab", description: "Switch between task list and inspector" },
	"app.tasks.previousFocus": { defaultKeys: "shift+tab", description: "Switch between task inspector and list" },
	"app.tasks.help": { defaultKeys: "?", description: "Show task controls" },
} as const;

registerKeybindings(TASK_KEYBINDINGS);

registerReservedKeybindings("app.tasks.detach");

registerKeybindingHelpSection({
	id: "tasks",
	title: "Tasks",
	rows: [
		{ action: "app.tasks.detach", description: TASK_KEYBINDINGS["app.tasks.detach"].description },
		{
			action: "app.tasks.detachSelected",
			description: `${TASK_KEYBINDINGS["app.tasks.detachSelected"].description} (while /tasks is open)`,
		},
	],
});
