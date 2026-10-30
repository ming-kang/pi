import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AppKeybinding, Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { TaskInspector } from "./inspector.ts";
import type { TaskList } from "./list.ts";
import { isStoppable, type PanelFocus, type PanelMode, type TaskSelection, type TasksTab } from "./model.ts";
import { modeName, statusName, statusView } from "./status.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";
import type { TaskViewport } from "./viewport.ts";

export interface TaskHit {
	x: number;
	y: number;
	width: number;
	key?: AppKeybinding;
	taskId?: string;
	tab?: TasksTab;
	cancel?: boolean;
}
export interface TasksLayout {
	hits: TaskHit[];
	listWidth: number;
	listPageSize: number;
	lines: string[];
	/** The terminal is below the supported size; only a full-screen resize notice is shown. */
	tooSmall?: boolean;
}
interface LayoutOptions {
	width: number;
	height: number;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "getKeys">;
	selection: TaskSelection;
	inspector: TaskInspector;
	list: TaskList;
	focus: PanelFocus;
	mode: PanelMode;
	/** Renders the search input line; shown only in search mode. */
	searchLine: (width: number) => string;
	feedback?: string;
	/** Whether the host would move this task to the background now. */
	canDetach: (id: string) => boolean;
}
const pad = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", true);
/** Visible width of "Output  Details". */
const TABS_WIDTH = 15;

/** Cell geometry and mouse targets are produced together, so resize cannot separate them. */
export function renderTasksLayout(options: LayoutOptions): TasksLayout {
	const { width, height, theme, selection, inspector, list, focus, keybindings, mode } = options;
	const hint = (key: Keybinding) => keyLabel(key, { keybindings });
	const result: TasksLayout = { hits: [], listWidth: 0, listPageSize: 1, lines: [] };
	if (width < 1 || height < 1) return result;
	const wide = width >= 100;
	const listWidth = wide ? Math.min(42, Math.max(32, Math.floor(width * 0.32))) : width;
	const rightWidth = wide ? width - listWidth - 1 : width;
	const rightX = wide ? listWidth + 1 : 0;
	const bodyHeight = height - 5;
	const hits = result.hits;
	result.listWidth = listWidth;
	// One row per task, less the group headings.
	result.listPageSize = Math.max(1, bodyHeight - 2);
	const pane = (lines: string[], size: number, active: boolean): string[] => {
		const border = (text: string) => theme.fg(wide && active ? "borderAccent" : "borderMuted", text);
		return [
			border(`┌${"─".repeat(size - 2)}┐`),
			...lines.map((line) => border("│") + pad(line, size - 2) + border("│")),
			border(`└${"─".repeat(size - 2)}┘`),
		];
	};
	if (width < 60 || height < 14) {
		// The panel is modal: a floating notice would leave the transcript visible yet
		// unscrollable, so the notice owns every row as a centered dialog. Only a truly
		// tiny terminal, where even the dialog does not fit, gets bare covering lines.
		result.tooSmall = true;
		const message = "Terminal too small for /tasks. Enlarge the window to continue.";
		const close = `${hint("tui.select.cancel")} close`;
		const boxWidth = Math.min(width, 46);
		const inner = boxWidth - 2;
		const wrapped = wrapTextWithAnsi(message, inner).map((line) => theme.fg("warning", line));
		const spacious = [theme.fg("text", "Tasks"), "", ...wrapped, "", theme.fg("dim", close)];
		const tight = [theme.fg("text", "Tasks"), ...wrapped, theme.fg("dim", close)];
		const body = height >= spacious.length + 2 ? spacious : tight;
		if (inner >= 16 && height >= body.length + 2) {
			const box = pane(body, boxWidth, false);
			const left = Math.floor((width - boxWidth) / 2);
			const top = Math.max(0, Math.floor((height - box.length) / 2));
			const blank = " ".repeat(width);
			result.lines = [
				...Array.from({ length: top }, () => blank),
				...box.map((line) => " ".repeat(left) + line + " ".repeat(width - left - boxWidth)),
				...Array.from({ length: height - top - box.length }, () => blank),
			];
			hits.push({ x: left + 1, y: top + body.length, width: visibleWidth(close), cancel: true });
		} else {
			result.lines = ["Tasks", message, close].slice(0, height).map((line) => pad(line, width));
			while (result.lines.length < height) result.lines.push(" ".repeat(width));
		}
		return result;
	}
	const visible = list.render(selection, theme, listWidth - 2, bodyHeight);
	let listHeader = theme.fg("text", "Tasks");
	const searchLabel = `${hint("app.tasks.search")} find`;
	if (mode.kind === "search") listHeader = options.searchLine(listWidth - 2);
	else {
		const x = Math.max(6, listWidth - 2 - visibleWidth(searchLabel));
		listHeader += " ".repeat(x - 5) + theme.fg("dim", searchLabel);
		if (wide || focus === "list")
			hits.push({ x: x + 1, y: 1, width: visibleWidth(searchLabel), key: "app.tasks.search" });
	}
	if (wide || focus === "list")
		visible.forEach((row, index) => {
			if (row.taskId) hits.push({ x: 1, y: 2 + index, width: listWidth - 2, taskId: row.taskId });
		});
	const left = [
		listHeader,
		...Array.from({ length: bodyHeight }, (_, i) => visible[i]?.text ?? ""),
		theme.fg("dim", list.range),
	];
	const task = inspector.task;
	const tab = selection.state.tab;
	const tabLabel = (id: TasksTab, label: string) => theme.style(label, { fg: "text", underline: tab === id });
	// One header row in every layout: the selected task's source and status, with the tabs on the right.
	const tabsX = rightWidth - 2 - TABS_WIDTH;
	const summary = task
		? [
				theme.fg("muted", cleanTaskText(task.label)),
				theme.fg(statusView(task.status).color, statusName(task.status)),
				theme.fg("muted", runtimeLabel(task)),
			].join(theme.fg("dim", " · "))
		: "";
	const shownSummary = truncateToWidth(summary, Math.max(0, tabsX - 1), "…");
	const right = [
		`${shownSummary}${" ".repeat(tabsX - visibleWidth(shownSummary))}${tabLabel("output", "Output")}  ${tabLabel("info", "Details")}`,
	];
	if (wide || focus === "inspector")
		hits.push(
			{ x: rightX + 1 + tabsX, y: 1, width: 6, tab: "output" },
			{ x: rightX + 9 + tabsX, y: 1, width: 7, tab: "info" },
		);
	const content: string[] = [];
	let reading = "";
	if (task) {
		// Without the list beside it, the inspector names the task it shows.
		if (!wide) content.push(theme.fg("text", cleanTaskText(firstCommandLine(task.title))));
		const position = inspector.position;
		const read = position.read;
		const terminal = isTaskTerminal(task.status);
		const diagnostics = [task.error, read?.readError].filter((text): text is string => !!text).map(cleanTaskText);
		if (tab === "output" && diagnostics.length)
			content.push(theme.fg("warning", diagnostics.join(" · ").replace(/\n/g, " ")));
		const source =
			tab === "info"
				? inspector.details(`${statusName(task.status)} · ${modeName(task.mode)} · ${runtimeLabel(task)}`)
				: inspector.output(rightWidth - 2);
		content.push(...position[tab].layout(source, rightWidth - 2, bodyHeight - content.length));
		if (tab === "output") {
			// Only a log holds a browsed snapshot; other output is always the current result.
			const settled = terminal && task.outputPath === undefined;
			reading =
				position.output.follow || settled
					? terminal
						? "Finished"
						: "Live"
					: terminal
						? `Finished · ${hint("app.tasks.follow")} load final output`
						: `Browsing · ${hint("app.tasks.follow")} follow output`;
			if (!position.output.follow && !settled && (wide || focus === "inspector"))
				hits.push({
					x: rightX + 1,
					y: height - 3,
					width: Math.min(rightWidth - 2, visibleWidth(reading)),
					key: "app.tasks.follow",
				});
			if (task.outputPath !== undefined && read?.truncated)
				reading += ` · Tail preview: ${formatSize(Buffer.byteLength(read.text))} of ${formatSize(read.totalBytes)}`;
		} else if (tab === "info") reading = `Details ${position.info.range}`;
	} else content.push(theme.fg("muted", "Select a task to inspect its result."));
	right.push(...Array.from({ length: bodyHeight }, (_, i) => content[i] ?? ""), theme.fg("dim", reading));
	const rightPane = pane(right, rightWidth, focus === "inspector");
	let panels = wide
		? pane(left, listWidth, focus === "list").map((line, i) => `${line} ${rightPane[i]}`)
		: pane(focus === "list" ? left : right, width, false);

	let footer = "";
	const addHint = (key: Keybinding, label: string, target?: Omit<TaskHit, "x" | "y" | "width">) => {
		const text = `${hint(key)} ${label}`;
		const x = visibleWidth(footer) + (footer ? 3 : 0);
		if (x + visibleWidth(text) > width) return;
		footer += (footer ? " · " : "") + text;
		if (target) hits.push({ x, y: height - 1, width: visibleWidth(text), ...target });
	};
	if (mode.kind === "help") {
		hits.length = 0;
		panels = pane(helpLines(mode.viewport, hint, theme, width, height), width, false);
		addHint("tui.select.up", `/ ${hint("tui.select.down")} scroll`);
		addHint("tui.select.cancel", "back", { cancel: true });
	} else if (mode.kind === "confirmStop") {
		// The question borrows only the footer row, so the task stays in view while confirming.
		hits.length = 0;
		const target = selection.all.find((task) => task.id === mode.taskId);
		const source = cleanTaskText(target?.label ?? "task");
		const confirm = `${hint("app.tasks.confirmStop")} stop`;
		const cancel = `${hint("tui.select.cancel")} cancel`;
		const actions = `${confirm} · ${cancel}`;
		const room = width - visibleWidth(`Stop ${source} ""?  ${actions}`);
		const title = cleanTaskText(firstCommandLine(target?.title ?? mode.taskId));
		const question = room >= 4 ? `Stop ${source} "${truncateToWidth(title, room, "…")}"?  ` : `Stop ${source}?  `;
		footer = question + actions;
		const x = visibleWidth(question);
		hits.push(
			{ x, y: height - 1, width: visibleWidth(confirm), key: "app.tasks.confirmStop" },
			{ x: x + visibleWidth(confirm) + 3, y: height - 1, width: visibleWidth(cancel), cancel: true },
		);
	} else if (mode.kind === "search") {
		// Only search candidates and cancellation are clickable while locating a task.
		for (let i = hits.length - 1; i >= 0; i--) if (!hits[i]!.taskId) hits.splice(i, 1);
		addHint("tui.select.up", `/ ${hint("tui.select.down")} choose`);
		addHint("tui.select.confirm", "locate");
		addHint("tui.select.cancel", "cancel", { cancel: true });
	} else {
		addHint("tui.select.up", `/ ${hint("tui.select.down")}${focus === "list" ? " tasks" : " scroll"}`);
		if (focus === "list") addHint("tui.select.confirm", "open", { tab });
		else addHint("app.tasks.nextFocus", "tasks", { key: "app.tasks.nextFocus" });
		addHint("tui.select.cancel", "close", { cancel: true });
		if (focus === "list") addHint("app.tasks.search", "find", { key: "app.tasks.search" });
		else {
			addHint("app.tasks.previousTab", "output", { tab: "output" });
			addHint("app.tasks.nextTab", "details", { tab: "info" });
		}
		if (task && isStoppable(task)) addHint("app.tasks.kill", "stop", { key: "app.tasks.kill" });
		if (task && options.canDetach(task.id))
			addHint("app.tasks.detachSelected", "background", { key: "app.tasks.detachSelected" });
		addHint("app.tasks.help", "keys", { key: "app.tasks.help" });
		// Feedback borrows the hint row, so the hint hit targets stay live and the click that
		// dismisses it can act in the same gesture.
		if (options.feedback) footer = options.feedback;
	}
	result.lines = [...panels, theme.fg(mode.kind === "confirmStop" ? "warning" : "dim", pad(footer, width))];
	return result;
}

/** Controls grouped by purpose; actions sharing a key, such as list and inspector paging, share a row. */
function helpLines(
	help: TaskViewport,
	hint: (key: Keybinding) => string,
	theme: Theme,
	width: number,
	height: number,
): string[] {
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
				[hint("tui.select.cancel"), "Close search, help or confirmation; otherwise the panel"],
			],
		],
	];
	const keyWidth = Math.max(...sections.flatMap(([, rows]) => rows.map(([key]) => visibleWidth(key)))) + 2;
	const rows = sections.flatMap(([title, entries], index) => [
		...(index ? [""] : []),
		theme.fg("accent", title),
		...entries.map(([key, label]) => `  ${key}${" ".repeat(keyWidth - visibleWidth(key))}${label}`),
	]);
	const body = [theme.fg("text", "Task controls"), ...help.layout(rows, width - 2, height - 5), ""];
	while (body.length < height - 3) body.push("");
	return body;
}
