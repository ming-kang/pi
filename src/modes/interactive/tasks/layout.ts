import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal } from "../../../core/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import { keyLabel } from "../components/keybinding-hints.ts";
import { statusMarker } from "../components/status-marker.ts";
import type { Theme } from "../theme/theme.ts";
import type { TaskInspector } from "./inspector.ts";
import type { TaskSelection } from "./model.ts";
import { statusName } from "./task-view.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";
import type { TaskViewport } from "./viewport.ts";

export interface TaskHit {
	x: number;
	y: number;
	width: number;
	key?: AppKeybinding;
	taskId?: string;
}
export interface TasksLayout {
	hits: TaskHit[];
	listWidth: number;
	listPageSize: number;
	contentY: number;
	lines: string[];
}
interface LayoutOptions {
	width: number;
	height: number;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "getKeys">;
	selection: TaskSelection;
	inspector: TaskInspector;
	focus: "list" | "inspector";
	searchLine?: string;
	pendingKill?: string;
	feedback?: string;
	help?: TaskViewport;
	canDetach: boolean;
}
const pad = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", true);

/** Cell geometry and mouse targets are produced together, so resize cannot separate them. */
export function renderTasksLayout(options: LayoutOptions): TasksLayout {
	const { width, height, theme, selection, inspector, focus, keybindings } = options;
	const hint = (key: Parameters<typeof keybindings.getKeys>[0]) => keyLabel(key, { keybindings });
	const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
	const result: TasksLayout = { hits: [], listWidth: 0, listPageSize: 1, contentY: 7, lines: [] };
	if (width < 1 || height < 1) return result;
	if (width < 60 || height < 14) {
		result.lines = [rule, "Terminal too small for /tasks. Resize to 60×14.", `${hint("tui.select.cancel")} close`]
			.slice(0, height)
			.map((line) => pad(line, width));
		return result;
	}
	const wide = width >= 100;
	const listWidth = wide ? Math.min(34, Math.max(30, Math.floor(width * 0.28))) : width;
	const bodyHeight = height - 5;
	result.listWidth = listWidth;
	result.listPageSize = Math.max(1, Math.floor((bodyHeight - 2) / 2));
	const title = `${theme.fg("accent", theme.bold("Tasks"))}${theme.fg("muted", ` · ${selection.activeCount} active · ${selection.recentCount} recent background/report results`)}`;
	const hits = result.hits;
	let toolbar = "";
	for (const filter of ["overview", "active", "history"] as const) {
		const key = `app.tasks.${filter}` as const;
		const text = `${hint(key)} ${statusName(filter)}`;
		hits.push({ x: visibleWidth(toolbar), y: 2, width: visibleWidth(text), key });
		toolbar += `${theme.fg(selection.state.filter === filter ? "accent" : "muted", text)}  `;
	}
	const searchLabel = selection.state.query
		? `Find: ${cleanTaskText(selection.state.query)}`
		: `${hint("app.tasks.search")} find`;
	hits.push({
		x: visibleWidth(toolbar),
		y: 2,
		width: Math.max(1, width - visibleWidth(toolbar)),
		key: "app.tasks.search",
	});
	toolbar += theme.fg("dim", searchLabel);
	if (options.searchLine !== undefined) {
		toolbar = options.searchLine;
		hits.length = 0;
	}
	const list: { text: string; taskId?: string }[] = [];
	let group = "",
		selectedLine = 0;
	for (const task of selection.rows) {
		const nextGroup = selection.group(task);
		if (nextGroup !== group) {
			list.push({ text: theme.fg("dim", nextGroup) });
			group = nextGroup;
		}
		const selected = task.id === selection.state.selectedId;
		if (selected) selectedLine = list.length;
		const marker = statusMarker(task.status, { now: Date.now() });
		const label = cleanTaskText(firstCommandLine(task.command ?? task.title));
		let primary = pad(
			`${selected ? theme.fg(focus === "list" ? "accent" : "muted", "→ ") : "  "}${theme.fg(marker.color, marker.glyph)} ${theme.fg("text", label)}`,
			listWidth,
		);
		let secondary = pad(
			`    ${theme.fg(marker.color, statusName(task.status))}${theme.fg("muted", ` · ${task.mode === "foreground" ? "FG" : "BG"} · ${runtimeLabel(task)}`)}`,
			listWidth,
		);
		if (selected) {
			primary = theme.bg("selectedBg", primary);
			secondary = theme.bg("selectedBg", secondary);
		}
		list.push({ text: primary, taskId: task.id }, { text: secondary, taskId: task.id });
	}
	if (!list.length)
		list.push({
			text: theme.fg(
				"muted",
				selection.state.query
					? "No matching tasks."
					: selection.state.filter === "active"
						? "No ongoing tasks."
						: "No retained tasks in this view.",
			),
		});
	if (selection.state.filter === "overview")
		list.push({ text: theme.fg("dim", `${hint("app.tasks.history")} History: all retained results`) });
	const first = Math.max(0, selectedLine - bodyHeight + 2);
	const visibleList = list.slice(first, first + bodyHeight);
	if (wide || focus === "list")
		visibleList.forEach((row, index) => {
			if (row.taskId) hits.push({ x: 0, y: 3 + index, width: listWidth, taskId: row.taskId });
		});
	const rightWidth = wide ? width - listWidth - 1 : width;
	const rightX = wide ? listWidth + 1 : 0;
	const task = inspector.task;
	let right: string[] = [];
	if (task) {
		const tab = selection.state.tab;
		const lines = inspector.lines(tab, rightWidth);
		const marker = statusMarker(task.status);
		const kind = task.kind === "powershell" ? "PowerShell" : task.kind === "bash" ? "Bash" : cleanTaskText(task.kind);
		right.push(theme.fg("text", theme.bold(cleanTaskText(firstCommandLine(task.command ?? task.title)))));
		right.push(
			`${theme.fg(marker.color, statusName(task.status))}${theme.fg("muted", ` · ${kind} · ${statusName(task.mode)} · ${runtimeLabel(task)}${task.exitCode !== undefined ? ` · exit ${task.exitCode ?? "signal"}` : ""}`)}`,
		);
		let tabs = `${theme.fg(tab === "output" ? "accent" : "muted", "Output")}  ${theme.fg(tab === "info" ? "accent" : "muted", "Information")}`;
		const position = inspector.position,
			read = position.read;
		const following = inspector.tail && tab === "output";
		const follow = following
			? !position.output.follow
				? isTaskTerminal(task.status)
					? `Finished; ${hint("app.tasks.follow")} load final output`
					: `Browsing · ${hint("app.tasks.follow")} follow`
				: isTaskTerminal(task.status)
					? "Saved result"
					: "Following output"
			: "";
		if (follow)
			tabs +=
				" ".repeat(Math.max(1, rightWidth - visibleWidth(tabs) - visibleWidth(follow))) + theme.fg("dim", follow);
		if (wide || focus === "inspector") {
			hits.push(
				{ x: rightX, y: 5, width: 6, key: "app.tasks.focusPreview" },
				{ x: rightX + 8, y: 5, width: 11, key: "app.tasks.focusInfo" },
			);
			if (following)
				hits.push({
					x: rightX + Math.max(20, rightWidth - visibleWidth(follow)),
					y: 5,
					width: Math.min(rightWidth - 20, visibleWidth(follow)),
					key: "app.tasks.follow",
				});
		}
		right.push(tabs);
		const diagnostics = [task.error, inspector.error, read?.readError].filter((text): text is string => !!text);
		const content = tab === "info" ? [`Task ID   ${task.id}`, ...diagnostics.map(cleanTaskText), ...lines] : lines;
		if (tab === "output" && diagnostics.length)
			right.push(theme.fg("warning", cleanTaskText(diagnostics.join(" · ")).replace(/\n/g, " ")));
		const contentHeight = Math.max(1, bodyHeight - right.length - 1);
		const shown = position[tab].layout(content, rightWidth, contentHeight);
		const size =
			read && tab === "output"
				? ` · ${formatSize(Buffer.byteLength(read.text))} of ${formatSize(read.totalBytes)}${read.truncated ? " · truncated" : ""}`
				: "";
		right.push(theme.fg("dim", `${tab === "info" ? "Information" : "Preview"} ${position[tab].range}${size}`));
		result.contentY = 3 + right.length;
		right.push(...shown);
	} else
		right = [
			theme.fg("muted", "Select a task to inspect its result."),
			theme.fg("dim", `${hint("app.tasks.history")} History includes foreground results.`),
		];
	let body = wide
		? Array.from(
				{ length: bodyHeight },
				(_, i) =>
					`${pad(visibleList[i]?.text ?? "", listWidth)}${theme.fg("borderMuted", "│")}${pad(right[i] ?? "", rightWidth)}`,
			)
		: focus === "list"
			? visibleList.map((row) => row.text)
			: right;
	if (options.help) {
		hits.length = 0;
		const controls: [AppKeybinding, string][] = [
			["app.tasks.overview", "Overview: active work and recent results"],
			["app.tasks.active", "Active work"],
			["app.tasks.history", "All retained history"],
			["app.tasks.search", "Find by task title, command, kind or ID"],
			["app.tasks.nextFocus", "Next region"],
			["app.tasks.previousFocus", "Previous region"],
			["app.tasks.focusList", "Task list"],
			["app.tasks.focusPreview", "Output"],
			["app.tasks.focusInfo", "Information"],
			["app.tasks.follow", "Follow latest/final output"],
			["app.tasks.top", "Top of list or bounded preview"],
			["app.tasks.bottom", "Bottom of list or bounded preview"],
			["app.tasks.detachSelected", "Move selected task to background"],
			["app.tasks.detach", "Move ALL eligible foreground tasks to background"],
			["app.tasks.kill", "Request stop of selected whole task"],
			["app.tasks.confirmStop", "Confirm stop"],
		];
		body = options.help.layout(
			controls.map(([key, label]) => `${hint(key).padEnd(14)} ${label}`),
			width,
			bodyHeight,
		);
	}
	while (body.length < bodyHeight) body.push("");
	const footerHints = [
		`${hint("tui.select.up")}/${hint("tui.select.down")} ${focus === "list" ? "select" : "scroll"}`,
		`${hint("app.tasks.nextFocus")} focus`,
	];
	if (task && !isTaskTerminal(task.status) && task.status !== "stopping")
		footerHints.push(`${hint("app.tasks.kill")} stop`);
	if (task?.mode === "foreground" && !isTaskTerminal(task.status) && task.status !== "stopping" && options.canDetach)
		footerHints.push(`${hint("app.tasks.detachSelected")} background`);
	footerHints.push(
		`${hint("app.tasks.help")} keys`,
		`${hint("tui.select.cancel")} ${focus === "list" ? "close" : "back"}`,
	);
	let footer = options.help
		? `${hint("tui.select.up")}/${hint("tui.select.down")} scroll controls · ${hint("tui.select.cancel")} back`
		: (options.feedback ?? footerHints.join(" · "));
	if (options.pendingKill) {
		const label = cleanTaskText(firstCommandLine(task?.command ?? task?.title ?? options.pendingKill));
		footer = `${hint("app.tasks.confirmStop")} confirm · ${hint("tui.select.cancel")} cancel · Stop ${label} (whole task)?`;
		hits.length = 0;
		hits.push({
			x: 0,
			y: height - 2,
			width: visibleWidth(`${hint("app.tasks.confirmStop")} confirm`),
			key: "app.tasks.confirmStop",
		});
	}
	result.lines = [
		rule,
		title,
		toolbar,
		...body.slice(0, bodyHeight),
		theme.fg(options.pendingKill ? "warning" : "dim", footer),
		rule,
	].map((line) => pad(line, width));
	return result;
}
