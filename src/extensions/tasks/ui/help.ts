/** The `?` controls page: every binding grouped by purpose, with the user's current keys. */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Keybinding } from "../../../core/keybindings.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

/** Controls grouped by purpose; actions sharing a key, such as list and inspector paging, share a row. */
export function helpRows(hint: (key: Keybinding) => string, theme: Theme): string[] {
	const keys = (...bindings: Keybinding[]) => [...new Set(bindings.map(hint).filter(Boolean))].join(" / ");
	const listPage = keys("tui.select.pageUp", "tui.select.pageDown");
	const inspectorPage = keys("tui.editor.pageUp", "tui.editor.pageDown");
	const paging: Array<[string, string]> =
		listPage === inspectorPage
			? [[listPage, "Page the list or inspector"]]
			: [
					[listPage, "Page the list"],
					[inspectorPage, "Page the inspector"],
				];
	const sections: Array<[string, Array<[string, string]>]> = [
		[
			"Navigate",
			[
				[keys("tui.select.up", "tui.select.down"), "Select a task, or scroll the inspector"],
				...paging,
				[keys("app.tasks.top", "app.tasks.bottom"), "Top or bottom"],
				[hint("tui.select.confirm"), "Open the selected task"],
				[keys("app.tasks.nextFocus", "app.tasks.previousFocus"), "Switch between list and inspector"],
			],
		],
		[
			"View",
			[
				[keys("app.tasks.previousTab", "app.tasks.nextTab"), "Output or Details, in the inspector"],
				[hint("app.tasks.follow"), "Follow the latest output, or load the final output"],
				[hint("app.tasks.search"), "Find a task; Enter locates it, Esc restores the selection"],
			],
		],
		[
			"Act",
			[
				[hint("app.tasks.kill"), `Stop the selected task; ${hint("app.tasks.confirmStop")} confirms`],
				[hint("app.tasks.detachSelected"), "Move the selected foreground task to the background"],
				[hint("app.tasks.detach"), "Move every foreground execution to the background"],
				[
					hint("tui.select.cancel"),
					"Close search, help or confirmation; otherwise go back from the inspector in a narrow terminal, or close the panel",
				],
			],
		],
	];
	const keyWidth = Math.max(...sections.flatMap(([, rows]) => rows.map(([key]) => visibleWidth(key)))) + 2;
	return sections.flatMap(([title, entries], index) => [
		...(index ? [""] : []),
		theme.fg("accent", title),
		...entries.map(([key, label]) => `  ${key}${" ".repeat(keyWidth - visibleWidth(key))}${label}`),
	]);
}
