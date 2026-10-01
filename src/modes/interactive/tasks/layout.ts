import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AppKeybinding, Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import { keyLabel } from "../components/keybinding-hints.ts";
import type { Theme } from "../theme/theme.ts";
import type { TaskInspector } from "./inspector.ts";
import type { TaskList } from "./list.ts";
import type { TaskSelection, TasksTab } from "./model.ts";
import { statusName } from "./task-view.ts";
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
}
interface LayoutOptions {
	width: number;
	height: number;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "getKeys">;
	selection: TaskSelection;
	inspector: TaskInspector;
	list: TaskList;
	focus: "list" | "inspector";
	searchLine?: (width: number) => string;
	pendingKill?: string;
	feedback?: string;
	help?: TaskViewport;
	canDetach: boolean;
}
const pad = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", true);

/** Cell geometry and mouse targets are produced together, so resize cannot separate them. */
export function renderTasksLayout(options: LayoutOptions): TasksLayout {
	const { width, height, theme, selection, inspector, list, focus, keybindings } = options;
	const hint = (key: Keybinding) => keyLabel(key, { keybindings });
	const result: TasksLayout = { hits: [], listWidth: 0, listPageSize: 1, lines: [] };
	if (width < 1 || height < 1) return result;
	if (width < 60 || height < 14) {
		result.lines = ["Tasks", "Terminal too small for /tasks. Resize to 60×14.", `${hint("tui.select.cancel")} close`]
			.slice(0, height)
			.map((line) => pad(line, width));
		return result;
	}
	const wide = width >= 100;
	const listWidth = wide ? Math.min(42, Math.max(32, Math.floor(width * 0.32))) : width;
	const rightWidth = wide ? width - listWidth - 1 : width;
	const rightX = wide ? listWidth + 1 : 0;
	const bodyHeight = height - 5;
	const hits = result.hits;
	result.listWidth = listWidth;
	result.listPageSize = Math.max(1, Math.floor((bodyHeight - 1) / 2));
	const pane = (lines: string[], size: number, active: boolean): string[] => {
		const border = (text: string) => theme.fg(wide && active ? "borderAccent" : "borderMuted", text);
		return [
			border(`┌${"─".repeat(size - 2)}┐`),
			...lines.map((line) => border("│") + pad(line, size - 2) + border("│")),
			border(`└${"─".repeat(size - 2)}┘`),
		];
	};
	const visible = list.render(selection, theme, listWidth - 2, bodyHeight);
	let listHeader = theme.fg("text", "Tasks");
	const searchLabel = `${hint("app.tasks.search")} find`;
	if (options.searchLine) listHeader = options.searchLine(listWidth - 2);
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
	const right = [`${tabLabel("output", "Output")}  ${tabLabel("info", "Details")}`];
	if (wide || focus === "inspector")
		hits.push({ x: rightX + 1, y: 1, width: 6, tab: "output" }, { x: rightX + 9, y: 1, width: 7, tab: "info" });
	const content: string[] = [];
	let reading = "";
	if (task) {
		if (!wide)
			content.push(
				theme.fg("text", cleanTaskText(firstCommandLine(task.command ?? task.title))),
				theme.fg("muted", `${statusName(task.status)} · ${runtimeLabel(task)}`),
			);
		const lines = inspector.lines(tab, rightWidth - 2);
		const position = inspector.position;
		const read = position.read;
		const diagnostics = [task.error, inspector.error, read?.readError]
			.filter((text): text is string => !!text)
			.map(cleanTaskText);
		if (tab === "output" && diagnostics.length)
			content.push(theme.fg("warning", diagnostics.join(" · ").replace(/\n/g, " ")));
		const source =
			tab === "info"
				? [
						`Task ID   ${task.id}`,
						`Status    ${statusName(task.status)} · ${statusName(task.mode)} · ${runtimeLabel(task)}`,
						...diagnostics,
						...lines,
					]
				: lines;
		content.push(...position[tab].layout(source, rightWidth - 2, bodyHeight - content.length));
		if (tab === "output" && inspector.tail) {
			reading = position.output.follow
				? isTaskTerminal(task.status)
					? "Finished"
					: "Live"
				: isTaskTerminal(task.status)
					? `Finished · ${hint("app.tasks.follow")} load final output`
					: `Browsing · ${hint("app.tasks.follow")} follow output`;
			if (!position.output.follow && (wide || focus === "inspector"))
				hits.push({
					x: rightX + 1,
					y: height - 3,
					width: Math.min(rightWidth - 2, visibleWidth(reading)),
					key: "app.tasks.follow",
				});
			if (read?.truncated)
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
	if (options.help || options.pendingKill) {
		hits.length = 0;
		let body: string[];
		if (options.help) {
			const controls: [Keybinding, string][] = [
				["app.tasks.nextFocus", "Switch task list / inspector"],
				["app.tasks.previousFocus", "Switch inspector / task list"],
				["app.tasks.previousTab", "Output (inspector only)"],
				["app.tasks.nextTab", "Details (inspector only)"],
				["tui.select.up", "Previous task / scroll up"],
				["tui.select.down", "Next task / scroll down"],
				["tui.select.pageUp", "Page up in task list"],
				["tui.select.pageDown", "Page down in task list"],
				["tui.editor.pageUp", "Page up in inspector"],
				["tui.editor.pageDown", "Page down in inspector"],
				["app.tasks.top", "Top of list / content"],
				["app.tasks.bottom", "Bottom of list / content"],
				["app.tasks.search", "Locate a retained task; Enter chooses, Escape restores selection"],
				["app.tasks.follow", "Follow latest / final output (Output only)"],
				["app.tasks.detachSelected", "Move selected foreground task to background"],
				["app.tasks.kill", "Request stop of selected whole task"],
				["app.tasks.confirmStop", "Confirm stop"],
				["tui.select.cancel", "Close current search, help or confirmation; otherwise close panel"],
			];
			body = [
				theme.fg("text", "Task controls"),
				...options.help.layout(
					controls.map(([key, label]) => hint(key).padEnd(14) + label),
					width - 2,
					height - 5,
				),
				"",
			];
			addHint("tui.select.up", `/ ${hint("tui.select.down")} scroll`);
			addHint("tui.select.cancel", "back", { cancel: true });
		} else {
			const target = selection.all.find((task) => task.id === options.pendingKill);
			const command = wrapTextWithAnsi(
				cleanTaskText(target?.command ?? target?.title ?? options.pendingKill!),
				width - 2,
			);
			const preview = command.slice(0, height - 8);
			if (preview.length < command.length) preview[preview.length - 1] = "… Full command in Details.";
			body = [
				theme.fg("text", "Stop task?"),
				"Stops the whole task, including its active work.",
				`Task ID: ${options.pendingKill}`,
				"",
				...preview,
			];
			addHint("app.tasks.confirmStop", "confirm", { key: "app.tasks.confirmStop" });
			addHint("tui.select.cancel", "cancel", { cancel: true });
		}
		while (body.length < height - 3) body.push("");
		panels = pane(body, width, false);
	} else if (options.searchLine) {
		// Only search candidates and cancellation are clickable while locating a task.
		for (let i = hits.length - 1; i >= 0; i--) if (!hits[i]!.taskId) hits.splice(i, 1);
		addHint("tui.select.up", `/ ${hint("tui.select.down")} choose`);
		addHint("tui.select.confirm", "locate");
		addHint("tui.select.cancel", "cancel", { cancel: true });
	} else {
		addHint("tui.select.up", `/ ${hint("tui.select.down")}${focus === "list" ? " tasks" : " scroll"}`);
		addHint("app.tasks.nextFocus", focus === "list" ? (tab === "output" ? "output" : "details") : "tasks", {
			key: "app.tasks.nextFocus",
		});
		addHint("tui.select.cancel", "close", { cancel: true });
		if (focus === "list") addHint("app.tasks.search", "find", { key: "app.tasks.search" });
		else {
			addHint("app.tasks.previousTab", "output", { tab: "output" });
			addHint("app.tasks.nextTab", "details", { tab: "info" });
		}
		if (task && !isTaskTerminal(task.status) && task.status !== "stopping") {
			addHint("app.tasks.kill", "stop", { key: "app.tasks.kill" });
			if (task.mode === "foreground" && options.canDetach)
				addHint("app.tasks.detachSelected", "background", { key: "app.tasks.detachSelected" });
		}
		addHint("app.tasks.help", "keys", { key: "app.tasks.help" });
		if (options.feedback) {
			footer = options.feedback;
			for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.y === height - 1) hits.splice(i, 1);
		}
	}
	result.lines = [...panels, theme.fg(options.pendingKill ? "warning" : "dim", pad(footer, width))];
	return result;
}
