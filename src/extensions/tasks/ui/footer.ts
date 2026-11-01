/**
 * The footer row, one builder per panel mode. Context hints sit on the left, the Escape action is
 * pinned to the right edge, and transient feedback temporarily replaces the hints.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Keybinding } from "../../../core/keybindings.ts";
import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";
import type { PanelFocus, TaskAction, TaskHit } from "./model.ts";

/** An outcome the panel does not already show: the action did not do what was asked. */
export interface Feedback {
	tone: "warning" | "error";
	text: string;
}

const FEEDBACK_GLYPH: Record<Feedback["tone"], string> = { warning: "!", error: "×" };
/** Cells kept between the left content and the pinned Escape action. */
const GAP = 3;

interface FooterItem {
	text: string;
	/** Higher numbers are dropped first when the row is too narrow. */
	priority: number;
	action?: TaskAction;
}

interface FooterSpec {
	items: FooterItem[];
	separator: string;
	escape: FooterItem;
	tone: ThemeColor;
	feedback?: Feedback;
}

export interface FooterEnv {
	width: number;
	/** The footer's screen row. */
	y: number;
	theme: Theme;
	hint: (key: Keybinding) => string;
	feedback?: Feedback;
}

export interface Footer {
	line: string;
	hits: TaskHit[];
}

/** Drops the lowest-priority items, the later of equals first, until the rest fit. */
function dropToFit(items: FooterItem[], room: number, separator: string): FooterItem[] {
	const kept = [...items];
	const width = () =>
		kept.reduce((sum, item) => sum + visibleWidth(item.text), 0) + visibleWidth(separator) * (kept.length - 1);
	while (kept.length > 1 && width() > room) {
		let drop = 0;
		for (const [index, item] of kept.entries()) if (item.priority >= kept[drop]!.priority) drop = index;
		kept.splice(drop, 1);
	}
	return kept;
}

function compose(env: FooterEnv, spec: FooterSpec): Footer {
	const { width, y, theme } = env;
	const hits: TaskHit[] = [];
	const escapeWidth = visibleWidth(spec.escape.text);
	const room = Math.max(0, width - escapeWidth - GAP);
	let showEscape = true;
	let left: string;
	if (spec.feedback) {
		const message = `${FEEDBACK_GLYPH[spec.feedback.tone]} ${spec.feedback.text}`;
		// A long message is worth more than the Escape hint while it lasts.
		showEscape = visibleWidth(message) <= room;
		left = theme.fg(spec.feedback.tone, truncateToWidth(message, showEscape ? room : width, "…"));
	} else {
		let x = 0;
		const kept = dropToFit(spec.items, room, spec.separator);
		for (const item of kept) {
			if (item.action) hits.push({ x, y, width: visibleWidth(item.text), action: item.action });
			x += visibleWidth(item.text) + visibleWidth(spec.separator);
		}
		left = theme.fg(spec.tone, truncateToWidth(kept.map((item) => item.text).join(spec.separator), room, "…"));
	}
	const gap = Math.max(0, width - visibleWidth(left) - (showEscape ? escapeWidth : 0));
	if (showEscape && spec.escape.action)
		hits.push({ x: width - escapeWidth, y, width: escapeWidth, action: spec.escape.action });
	return { line: left + " ".repeat(gap) + (showEscape ? theme.fg(spec.tone, spec.escape.text) : ""), hits };
}

const BACK: TaskAction = { kind: "back" };

export function browseFooter(
	env: FooterEnv,
	view: { focus: PanelFocus; split: boolean; stoppable: boolean; detachable: boolean },
): Footer {
	const { hint } = env;
	const items: FooterItem[] = [];
	const add = (text: string, priority: number, action?: TaskAction) => items.push({ text, priority, action });
	const arrows = `${hint("tui.select.up")} / ${hint("tui.select.down")}`;
	if (view.focus === "list") {
		add(`${arrows} tasks`, 5);
		add(`${hint("tui.select.confirm")} open`, 4, { kind: "open" });
		add(`${hint("app.tasks.search")} find`, 3, { kind: "key", key: "app.tasks.search" });
	} else {
		add(`${arrows} scroll`, 5);
		// Without the list beside it, Escape is the way back.
		if (view.split) add(`${hint("app.tasks.nextFocus")} tasks`, 6, { kind: "key", key: "app.tasks.nextFocus" });
		add(`${hint("app.tasks.previousTab")} output`, 6, { kind: "tab", tab: "output" });
		add(`${hint("app.tasks.nextTab")} details`, 6, { kind: "tab", tab: "info" });
	}
	if (view.stoppable) add(`${hint("app.tasks.kill")} stop`, 2, { kind: "key", key: "app.tasks.kill" });
	if (view.detachable)
		add(`${hint("app.tasks.detachSelected")} background`, 2, { kind: "key", key: "app.tasks.detachSelected" });
	add(`${hint("app.tasks.help")} keys`, 1, { kind: "key", key: "app.tasks.help" });
	const back = !view.split && view.focus === "inspector";
	return compose(env, {
		items,
		separator: " · ",
		escape: { text: `${hint("tui.select.cancel")} ${back ? "back" : "close"}`, priority: 0, action: BACK },
		tone: "dim",
		feedback: env.feedback,
	});
}

export function searchFooter(env: FooterEnv): Footer {
	const { hint } = env;
	return compose(env, {
		items: [
			{ text: `${hint("tui.select.up")} / ${hint("tui.select.down")} choose`, priority: 2 },
			{ text: `${hint("tui.select.confirm")} locate`, priority: 1 },
		],
		separator: " · ",
		escape: { text: `${hint("tui.select.cancel")} cancel`, priority: 0, action: BACK },
		tone: "dim",
		feedback: env.feedback,
	});
}

export function helpFooter(env: FooterEnv): Footer {
	const { hint } = env;
	return compose(env, {
		items: [{ text: `${hint("tui.select.up")} / ${hint("tui.select.down")} scroll`, priority: 1 }],
		separator: " · ",
		escape: { text: `${hint("tui.select.cancel")} back`, priority: 0, action: BACK },
		tone: "dim",
		feedback: env.feedback,
	});
}

/**
 * The stop question borrows only the footer row, so the task stays in view while confirming;
 * `source` and `title` name the target, and the title gives way first on narrow widths.
 */
export function confirmStopFooter(env: FooterEnv, target: { source: string; title: string }): Footer {
	const { hint, width } = env;
	const confirm = `${hint("app.tasks.confirmStop")} stop`;
	const cancel = `${hint("tui.select.cancel")} cancel`;
	const separator = "  ";
	const room = width - visibleWidth(cancel) - GAP - visibleWidth(separator + confirm);
	const bare = `Stop ${target.source}?`;
	const spare = room - visibleWidth(`Stop ${target.source} ""?`);
	const question = spare >= 4 ? `Stop ${target.source} "${truncateToWidth(target.title, spare, "…")}"?` : bare;
	return compose(env, {
		items: [
			{ text: question, priority: 0 },
			{ text: confirm, priority: 0, action: { kind: "key", key: "app.tasks.confirmStop" } },
		],
		separator,
		escape: { text: cancel, priority: 0, action: BACK },
		tone: "warning",
	});
}
