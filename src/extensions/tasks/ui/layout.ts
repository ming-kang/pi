/**
 * Screen layout. This is the only place that knows widths and row positions: it returns the
 * rendered lines together with the clickable cells and the pane regions the manager routes
 * wheel and focus gestures by, so a resize cannot separate geometry from targets.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	browseFooter,
	confirmStopFooter,
	type Feedback,
	type Footer,
	type FooterEnv,
	helpFooter,
	searchFooter,
} from "./footer.ts";
import { fitCell, framePane, type Rect } from "./frame.ts";
import { helpRows } from "./help.ts";
import type { TaskInspector } from "./inspector.ts";
import type { TaskList } from "./list.ts";
import type { PanelFocus, PanelMode, TaskHit, TaskSelection } from "./model.ts";
import { isStoppable } from "./model.ts";
import { type PaneRender, renderInspectorPane, renderListPane } from "./panes.ts";
import { cleanTaskText, firstCommandLine } from "./text.ts";

/** A terminal at least this wide shows the list beside the inspector. */
const SPLIT_MIN_WIDTH = 100;
/** The minimum supported terminal; below it a resize notice covers the screen. */
const MIN_WIDTH = 60;
const MIN_HEIGHT = 14;

/** A pane the pointer can act on: wheel scrolls it and a click on it focuses it. */
export interface PaneRegion extends Rect {
	pane: PanelFocus | "help";
}

export interface TasksLayout {
	lines: string[];
	hits: TaskHit[];
	regions: PaneRegion[];
	/** Both panes are visible; otherwise one pane at a time fills the width. */
	split: boolean;
	listPageSize: number;
	/** The terminal is below the supported size; only a full-screen resize notice is shown. */
	tooSmall?: boolean;
}

export interface LayoutOptions {
	width: number;
	height: number;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "getKeys">;
	selection: TaskSelection;
	inspector: TaskInspector;
	list: TaskList;
	focus: PanelFocus;
	mode: PanelMode;
	feedback?: Feedback;
	/** Whether the host would move this task to the background now. */
	canDetach: (id: string) => boolean;
}

/** The list takes 40% of a split terminal, between 34 and 60 columns. */
export function listWidthFor(width: number): number {
	return Math.min(60, Math.max(34, Math.round(width * 0.4)));
}

interface PaneRects {
	split: boolean;
	list: Rect;
	inspector: Rect;
}

/** Pane rectangles above the single footer row; without room for two, both panes share the full width. */
function paneRects(width: number, height: number): PaneRects {
	const rows = height - 1;
	if (width < SPLIT_MIN_WIDTH) {
		const full = { x: 0, y: 0, width, height: rows };
		return { split: false, list: full, inspector: full };
	}
	const listWidth = listWidthFor(width);
	return {
		split: true,
		list: { x: 0, y: 0, width: listWidth, height: rows },
		inspector: { x: listWidth + 1, y: 0, width: width - listWidth - 1, height: rows },
	};
}

export function renderTasksLayout(options: LayoutOptions): TasksLayout {
	const { width, height, theme, mode } = options;
	if (width < 1 || height < 1) return { lines: [], hits: [], regions: [], split: false, listPageSize: 1 };
	const hint = (key: Keybinding) => keyLabel(key, { keybindings: options.keybindings });
	if (width < MIN_WIDTH || height < MIN_HEIGHT) return renderTooSmall(options, hint);
	const rects = paneRects(width, height);
	const env: FooterEnv = { width, y: height - 1, theme, hint, feedback: options.feedback };
	let body: PaneRender & { regions: PaneRegion[]; pageSize?: number };
	let footer: Footer;
	switch (mode.kind) {
		case "help": {
			body = renderHelpPane(options, hint, { x: 0, y: 0, width, height: height - 1 });
			footer = helpFooter(env);
			break;
		}
		case "search": {
			body = renderPanes(options, hint, rects);
			footer = searchFooter(env);
			break;
		}
		case "confirmStop": {
			body = renderPanes(options, hint, rects);
			const target = options.selection.all.find((task) => task.id === mode.taskId);
			footer = confirmStopFooter(env, {
				source: cleanTaskText(target?.label ?? "task"),
				title: cleanTaskText(firstCommandLine(target?.title ?? mode.taskId)),
			});
			break;
		}
		case "browse": {
			body = renderPanes(options, hint, rects);
			const task = options.inspector.task;
			footer = browseFooter(env, {
				focus: options.focus,
				split: rects.split,
				stoppable: !!task && isStoppable(task),
				detachable: !!task && options.canDetach(task.id),
			});
			break;
		}
	}
	return {
		lines: [...body.lines, footer.line],
		hits: [...body.hits, ...footer.hits],
		regions: body.regions,
		split: rects.split,
		listPageSize: body.pageSize ?? Math.max(1, rects.list.height - 4),
	};
}

/**
 * Browse, search and confirmation share the two-pane frame; the mode decides which panes
 * answer to the pointer, so each mode exposes only its own targets.
 */
function renderPanes(
	options: LayoutOptions,
	hint: (key: Keybinding) => string,
	rects: PaneRects,
): PaneRender & { regions: PaneRegion[]; pageSize: number } {
	const { theme, selection, inspector, list, focus, mode } = options;
	const showList = rects.split || focus === "list";
	const showInspector = rects.split || focus === "inspector";
	const browsing = mode.kind === "browse";
	const searching = mode.kind === "search";
	const listPane = showList
		? renderListPane({ theme, selection, list }, rects.list, {
				active: rects.split && focus === "list",
				interactive: browsing || searching,
				searchRow: mode.kind === "search" ? mode.input.render(rects.list.width - 2).join("") : undefined,
				stopTargetId: mode.kind === "confirmStop" ? mode.taskId : undefined,
			})
		: undefined;
	const inspectorPane = showInspector
		? renderInspectorPane({ theme, selection, inspector, hint }, rects.inspector, {
				active: rects.split && focus === "inspector",
				interactive: browsing,
			})
		: undefined;
	const regions: PaneRegion[] = [];
	if (listPane && (browsing || searching)) regions.push({ pane: "list", ...rects.list });
	if (inspectorPane && browsing) regions.push({ pane: "inspector", ...rects.inspector });
	const lines =
		listPane && inspectorPane
			? listPane.lines.map((line, i) => `${line} ${inspectorPane.lines[i]}`)
			: (listPane ?? inspectorPane)!.lines;
	return {
		lines,
		hits: [...(listPane?.hits ?? []), ...(inspectorPane?.hits ?? [])],
		regions,
		pageSize: listPane?.pageSize ?? Math.max(1, rects.list.height - 4),
	};
}

function renderHelpPane(
	options: LayoutOptions,
	hint: (key: Keybinding) => string,
	rect: Rect,
): PaneRender & { regions: PaneRegion[] } {
	const { theme, mode } = options;
	if (mode.kind !== "help") throw new Error("help pane requires help mode");
	const inner = rect.width - 2;
	const rows = mode.viewport.layout(helpRows(hint, theme), inner, rect.height - 2);
	const frame = framePane({
		width: rect.width,
		theme,
		accent: false,
		title: theme.fg("text", "Task controls"),
		status: mode.viewport.overflows ? theme.fg("muted", mode.viewport.range) : undefined,
		rows: Array.from({ length: rect.height - 2 }, (_, i) => rows[i] ?? ""),
	});
	return { lines: frame.lines, hits: [], regions: [{ pane: "help", ...rect }] };
}

/**
 * The panel is modal: a floating notice would leave the transcript visible yet unscrollable,
 * so the notice owns every row as a centered dialog. Only a truly tiny terminal, where even
 * the dialog does not fit, gets bare covering lines.
 */
function renderTooSmall(options: LayoutOptions, hint: (key: Keybinding) => string): TasksLayout {
	const { width, height, theme } = options;
	const result: TasksLayout = { lines: [], hits: [], regions: [], split: false, listPageSize: 1, tooSmall: true };
	const message = "Terminal too small for /tasks. Enlarge the window to continue.";
	const close = `${hint("tui.select.cancel")} close`;
	const boxWidth = Math.min(width, 46);
	const inner = boxWidth - 2;
	const wrapped = wrapTextWithAnsi(message, inner).map((line) => theme.fg("warning", line));
	const spacious = [theme.fg("text", "Tasks"), "", ...wrapped, "", theme.fg("dim", close)];
	const tight = [theme.fg("text", "Tasks"), ...wrapped, theme.fg("dim", close)];
	const body = height >= spacious.length + 2 ? spacious : tight;
	if (inner >= 16 && height >= body.length + 2) {
		const box = framePane({ width: boxWidth, theme, accent: false, rows: body }).lines;
		const left = Math.floor((width - boxWidth) / 2);
		const top = Math.max(0, Math.floor((height - box.length) / 2));
		const blank = " ".repeat(width);
		result.lines = [
			...Array.from({ length: top }, () => blank),
			...box.map((line) => " ".repeat(left) + line + " ".repeat(width - left - boxWidth)),
			...Array.from({ length: height - top - box.length }, () => blank),
		];
		result.hits.push({ x: left + 1, y: top + body.length, width: visibleWidth(close), action: { kind: "back" } });
	} else {
		result.lines = ["Tasks", message, close].slice(0, height).map((line) => fitCell(line, width));
		while (result.lines.length < height) result.lines.push(" ".repeat(width));
	}
	return result;
}
