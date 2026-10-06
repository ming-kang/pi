import { type AppKeybinding, KEYBINDINGS } from "../../../core/keybindings.ts";
import type { TaskSnapshot } from "../../../core/tasks/types.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";

/**
 * Task rows for `/hotkeys`. Task keybindings act outside the editor, so they never showed up in
 * the editor-driven sections; labels come from KEYBINDINGS so the table cannot drift from the
 * binding registry.
 */
export function hotkeysTaskSection(display: (action: AppKeybinding) => string): string {
	const detach = KEYBINDINGS["app.tasks.detach"];
	const detachSelected = KEYBINDINGS["app.tasks.detachSelected"];
	return `
**Tasks**
| Key | Action |
|-----|--------|
| \`${display("app.tasks.detach")}\` | ${detach.description} |
| \`${display("app.tasks.detachSelected")}\` | ${detachSelected.description} (while /tasks is open) |
`;
}

/**
 * Ask before tree navigation cancels running tasks: results are saved on their launch branch,
 * so leaving it stops them. Resolves true when navigation may continue.
 */
export async function confirmStopBranchTasks(
	stopped: readonly TaskSnapshot[],
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<boolean> {
	if (stopped.length === 0) return true;
	const shown = stopped.slice(0, 5).map((task) => `  ${cleanTaskText(firstCommandLine(task.command ?? task.title))}`);
	if (stopped.length > shown.length) shown.push(`  …and ${stopped.length - shown.length} more`);
	return confirm(
		`Stop ${stopped.length} running task${stopped.length === 1 ? "" : "s"}?`,
		`They were started on the branch you are leaving and will be cancelled:\n${shown.join("\n")}`,
	);
}
