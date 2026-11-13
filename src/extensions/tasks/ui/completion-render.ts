/**
 * Human-facing completion notices. A notice only announces that background work
 * settled; input, facts and output stay in `/tasks`, so expansion adds nothing.
 * The persisted context message remains untouched.
 */
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { readVersionedTask } from "../../../core/tasks/codec.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import type { TaskStatus } from "../../../core/tasks/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { FramedComponent } from "../../../modes/interactive/tool-view/style.ts";
import { statusName, statusView } from "./status.ts";
import { cleanTaskText } from "./text.ts";

const SOURCE_LIMIT = 64 * 1024;
/** Display rows kept from a message whose details cannot be interpreted. */
const SAVED_ROWS = 4;

/** A persisted task completion, or the saved text of a message that is unreadable or from an older format. */
type CompletionView =
	| {
			kind: "task";
			label: string;
			title: string;
			duration: string;
			status: TaskStatus;
			id: string;
			diagnostic?: string;
	  }
	| { kind: "saved"; body: string; truncated: boolean };

function savedText(message: CustomMessage<unknown>): { text: string; clipped: boolean } {
	// 64K is a UTF-16 code-unit display budget, not a UTF-8 byte promise; the block
	// cap bounds iteration itself so many empty/non-text blocks cannot spin here.
	const MAX_SOURCE_BLOCKS = 256;
	const content = message.content;
	let text = "";
	let clipped = false;
	if (typeof content === "string") {
		text = content.slice(0, SOURCE_LIMIT);
		clipped = content.length > SOURCE_LIMIT;
	} else if (Array.isArray(content)) {
		let visited = 0;
		for (const block of content) {
			if (++visited > MAX_SOURCE_BLOCKS) {
				clipped = true;
				break;
			}
			if (!block || block.type !== "text" || typeof block.text !== "string") continue;
			const next = `${text ? "\n" : ""}${block.text.slice(0, SOURCE_LIMIT + 1)}`;
			const remaining = SOURCE_LIMIT - text.length;
			text += next.slice(0, remaining);
			if (next.length > remaining || block.text.length > SOURCE_LIMIT) {
				clipped = true;
				break;
			}
		}
	}
	return { text: cleanTaskText(text), clipped };
}

function completionView(message: CustomMessage<unknown>): CompletionView {
	const task = readVersionedTask(message.details);
	if (!task) {
		const { text, clipped } = savedText(message);
		return { kind: "saved", body: text, truncated: clipped };
	}
	return {
		kind: "task",
		label: cleanTaskText(task.label),
		title: cleanTaskText(task.title),
		duration: runtimeLabel(task),
		status: task.status,
		id: cleanTaskText(task.id),
		diagnostic: task.error === undefined ? undefined : cleanTaskText(task.error),
	};
}

function shortId(id: string): string {
	return id.replace(/^(.+)-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "$1-$2");
}

class CompletionNotice implements Component {
	private readonly view: CompletionView;
	private readonly options: MessageRenderOptions;
	private readonly theme: Theme;
	private readonly chrome: FramedComponent;
	constructor(view: CompletionView, options: MessageRenderOptions, theme: Theme) {
		this.view = view;
		this.options = options;
		this.theme = theme;
		this.chrome = new FramedComponent(
			{ render: (contentWidth) => this.renderContent(contentWidth), invalidate() {} },
			"header",
			() => (this.view.kind === "task" ? statusView(this.view.status).color : "muted"),
		);
	}
	invalidate(): void {
		this.chrome.invalidate();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		// The gutter reserves its own cells; clip defensively for one-cell terminals.
		return this.chrome.render(width).map((line) => truncateToWidth(line, width, ""));
	}
	private renderContent(width: number): string[] {
		// The chrome clamps to ≥1 already; keep the padding arithmetic safe regardless.
		if (!Number.isFinite(width) || width < 1) return [];
		const view = this.view;
		const theme = this.theme;
		// The native dot/rail replaces the default one-cell custom-message inset.
		// Additional configured padding stays inside the chrome, never shifting the dot.
		const padding = Math.min(Math.max(0, Math.floor(this.options.outputPad || 0) - 1), Math.floor((width - 1) / 2));
		const inner = width - padding * 2;
		const lines: string[] = [];
		if (view.kind === "task") {
			const duration = view.duration ? ` · ${view.duration}` : "";
			lines.push(
				`${theme.fg("toolTitle", theme.bold(view.label))}${theme.fg("muted", ` · Background ${statusName(view.status).toLowerCase()}${duration}`)}${theme.fg("dim", ` · ${shortId(view.id)}`)}`,
			);
			const summary = view.title.split("\n").find((line) => line.trim()) ?? view.title;
			if (summary) lines.push(theme.fg("toolOutput", summary));
			if (view.diagnostic) lines.push(theme.fg(statusView(view.status).color, view.diagnostic));
		} else {
			lines.push(
				`${theme.fg("toolTitle", theme.bold("Notification"))}${theme.fg("muted", " · Background result received")}`,
			);
			const body = wrapTextWithAnsi(view.body, inner).filter((line) => line.trim());
			for (const line of body.slice(0, SAVED_ROWS)) lines.push(theme.fg("toolOutput", line));
			if (body.length > SAVED_ROWS || view.truncated)
				lines.push(theme.fg("dim", "… saved text shortened; the original message remains in session history"));
		}
		return lines.map((line) => " ".repeat(padding) + truncateToWidth(line, inner, "…") + " ".repeat(padding));
	}
}

/** Always return a compact, replay-safe component, including for unknown historical formats. */
export function renderTaskCompletion(
	message: CustomMessage<unknown>,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	let view: CompletionView;
	try {
		view = completionView(message);
	} catch {
		view = {
			kind: "saved",
			body: "The saved notification could not be interpreted. Its original message remains in session history.",
			truncated: false,
		};
	}
	return new CompletionNotice(view, options, theme);
}
