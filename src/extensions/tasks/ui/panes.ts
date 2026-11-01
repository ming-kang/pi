/** The list and inspector panes. Each returns its own rows and only the hits it was asked to expose. */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Keybinding } from "../../../core/keybindings.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { isTaskTerminal, type TaskSnapshot } from "../../../core/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { framePane, type Rect, TITLE_INDENT } from "./frame.ts";
import type { TaskInspector } from "./inspector.ts";
import type { TaskList } from "./list.ts";
import type { TaskHit, TaskSelection, TasksTab } from "./model.ts";
import { modeName, statusName, statusView } from "./status.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";
import { streamsLog } from "./views.ts";

export interface PaneRender {
	lines: string[];
	hits: TaskHit[];
}

interface PaneEnv {
	theme: Theme;
	selection: TaskSelection;
}

export interface ListPaneOptions {
	/** The focused pane has an accented border. */
	active: boolean;
	/** Whether the rows can be clicked. */
	interactive: boolean;
	/** The rendered search input, shown as the first content row while searching. */
	searchRow?: string;
	/** The task a pending stop question is about. */
	stopTargetId?: string;
}

/** Task rows between the borders, and how many tasks a page moves. */
export function renderListPane(
	env: PaneEnv & { list: TaskList },
	rect: Rect,
	options: ListPaneOptions,
): PaneRender & { pageSize: number } {
	const { theme, selection, list } = env;
	const innerWidth = rect.width - 2;
	const rowsHeight = Math.max(1, rect.height - 2 - (options.searchRow === undefined ? 0 : 1));
	const visible = list.render(selection, theme, innerWidth, rowsHeight, options.stopTargetId);
	const first = options.searchRow === undefined ? 0 : 1;
	const hits: TaskHit[] = [];
	if (options.interactive)
		visible.forEach((row, index) => {
			if (row.taskId)
				hits.push({
					x: rect.x + 1,
					y: rect.y + 1 + first + index,
					width: innerWidth,
					action: { kind: "select", taskId: row.taskId },
				});
		});
	const active = selection.rows.filter((task) => !isTaskTerminal(task.status)).length;
	const finished = selection.rows.length - active;
	const counts = [active ? `${active} active` : "", finished ? `${finished} finished` : ""].filter(Boolean);
	const title = theme.fg("text", "Tasks") + (counts.length ? theme.fg("muted", ` · ${counts.join(" · ")}`) : "");
	const rows =
		options.searchRow === undefined
			? visible.map((row) => row.text)
			: [options.searchRow, ...visible.map((row) => row.text)];
	const frame = framePane({
		width: rect.width,
		theme,
		accent: options.active,
		title,
		status: list.range ? theme.fg("muted", list.range) : undefined,
		rows: Array.from({ length: rect.height - 2 }, (_, i) => rows[i] ?? ""),
	});
	return { lines: frame.lines, hits, pageSize: Math.max(1, rowsHeight - 2) };
}

export interface InspectorPaneOptions {
	active: boolean;
	interactive: boolean;
}

/** `Label · Status · Mode · runtime`, with the status in its own color. */
function metaLine(task: TaskSnapshot, theme: Theme): string {
	return [
		theme.fg("muted", cleanTaskText(task.label)),
		theme.fg(statusView(task.status).color, statusName(task.status)),
		theme.fg("muted", modeName(task.mode)),
		theme.fg("muted", runtimeLabel(task)),
	]
		.filter(Boolean)
		.join(theme.fg("dim", " · "));
}

/** The log's reading state: following, browsing a held snapshot, or finished. Other output has none. */
function readingState(
	task: TaskSnapshot,
	inspector: TaskInspector,
	hint: (key: Keybinding) => string,
): { text: string; followable: boolean } {
	const { output } = inspector.position;
	const terminal = isTaskTerminal(task.status);
	if (output.follow) return { text: terminal ? "Finished" : "Live", followable: false };
	const follow = hint("app.tasks.follow");
	return {
		text: terminal ? `Finished · ${follow} load final output` : `Browsing · ${follow} follow`,
		followable: true,
	};
}

export function renderInspectorPane(
	env: PaneEnv & { inspector: TaskInspector; hint: (key: Keybinding) => string },
	rect: Rect,
	options: InspectorPaneOptions,
): PaneRender {
	const { theme, selection, inspector, hint } = env;
	const innerWidth = rect.width - 2;
	const innerHeight = rect.height - 2;
	const task = inspector.task;
	const tab = selection.state.tab;
	const hits: TaskHit[] = [];
	// The tabs live in the top border; hit boxes follow the rendered label widths.
	const tabs: Array<[TasksTab, string]> = [
		["output", "Output"],
		["info", "Details"],
	];
	let tabX = rect.x + TITLE_INDENT;
	const title = tabs
		.map(([id, label]) => {
			if (options.interactive)
				hits.push({ x: tabX, y: rect.y, width: visibleWidth(label), action: { kind: "tab", tab: id } });
			tabX += visibleWidth(label) + 2;
			return theme.style(label, tab === id ? { fg: "text", underline: true } : { fg: "muted" });
		})
		.join("  ");
	const rows: string[] = [];
	let status = "";
	let followWidth = 0;
	let divider: number | undefined;
	if (task) {
		// A bold title and the meta line form a header; a rule joined to the frame separates it from the tab.
		rows.push(
			theme.style(cleanTaskText(firstCommandLine(task.title)), { fg: "text", bold: true }),
			metaLine(task, theme),
			"",
		);
		divider = rows.length - 1;
		const position = inspector.position;
		const read = position.read;
		const diagnostics = [task.error, read?.readError].filter((text): text is string => !!text).map(cleanTaskText);
		if (tab === "output" && diagnostics.length)
			rows.push(theme.fg("warning", diagnostics.join(" · ").replace(/\n/g, " ")));
		const body = Math.max(1, innerHeight - rows.length);
		if (tab === "info") {
			rows.push(...position.info.layout(inspector.details(innerWidth), innerWidth, body));
			if (position.info.overflows) status = theme.fg("muted", position.info.range);
		} else {
			rows.push(...position.output.layout(inspector.output(innerWidth), innerWidth, body));
			// Only a log has a reading state; a published result is always the current one.
			if (streamsLog(task)) {
				const reading = readingState(task, inspector, hint);
				status = theme.fg("muted", reading.text);
				if (read?.truncated)
					status += theme.fg(
						"muted",
						` · Tail preview: ${formatSize(Buffer.byteLength(read.text))} of ${formatSize(read.totalBytes)}`,
					);
				followWidth = reading.followable ? visibleWidth(reading.text) : 0;
			} else if (position.output.overflows) status = theme.fg("muted", position.output.range);
		}
	} else rows.push(theme.fg("muted", "Select a task to inspect its result."));
	const frame = framePane({
		width: rect.width,
		theme,
		accent: options.active,
		title,
		status: status || undefined,
		rows: Array.from({ length: innerHeight }, (_, i) => rows[i] ?? ""),
		divider,
	});
	// The held-snapshot state is itself the control that resumes following.
	if (options.interactive && followWidth)
		hits.push({
			x: rect.x + frame.status.x,
			y: rect.y + rect.height - 1,
			width: Math.min(followWidth, frame.status.width),
			action: { kind: "key", key: "app.tasks.follow" },
		});
	return { lines: frame.lines, hits };
}
