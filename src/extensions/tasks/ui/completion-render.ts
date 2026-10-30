/** Human-facing completion cards. The persisted context message remains untouched. */
import { type Component, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { readVersionedTask } from "../../../core/tasks/codec.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import type { TaskFact, TaskStatus } from "../../../core/tasks/types.ts";
import { type StatusMarkerColor, statusMarker } from "../../../modes/interactive/components/status-marker.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { FramedComponent } from "../../../modes/interactive/tool-view/style.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { statusName } from "./task-view.ts";

const SOURCE_LIMIT = 64 * 1024;
const CARD_ROWS = 128;
const OUTPUT_ROWS = 20;
interface CompletionView {
	label?: string;
	title?: string;
	duration?: string;
	status?: TaskStatus;
	id?: string;
	input?: { label: string; text: string };
	facts: TaskFact[];
	path?: string;
	diagnostic?: string;
	/** Undefined for an unreadable message, whose saved content is shown instead. */
	output?: string;
	/** A report previews its beginning; a log previews its end. */
	report?: boolean;
	body: string;
	truncated: boolean;
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
}

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
	return { text: clean(text), clipped };
}

function completionView(message: CustomMessage<unknown>): CompletionView {
	const task = readVersionedTask(message.details);
	if (!task) {
		const { text, clipped } = savedText(message);
		return { body: text, truncated: clipped, facts: [] };
	}
	return {
		label: clean(task.label),
		title: clean(task.title),
		duration: runtimeLabel(task),
		status: task.status,
		id: clean(task.id),
		input: task.input && { label: clean(task.input.label), text: clean(task.input.text) },
		facts: (task.facts ?? []).map(([label, value]) => [clean(label), clean(value)]),
		path: task.outputPath === undefined ? undefined : clean(task.outputPath),
		diagnostic: task.error === undefined ? undefined : clean(task.error),
		output: clean(task.result?.text ?? ""),
		report: task.output === "report",
		body: "",
		truncated: task.result?.truncated === true || task.input?.truncated === true,
	};
}

function color(status: string | undefined): StatusMarkerColor {
	return status === undefined ? "muted" : statusMarker(status).color;
}
function shortId(id: string): string {
	return id.replace(/^(.+)-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "$1-$2");
}

class CompletionCard implements Component {
	private readonly view: CompletionView;
	private readonly options: MessageRenderOptions;
	private readonly theme: Theme;
	constructor(view: CompletionView, options: MessageRenderOptions, theme: Theme) {
		this.view = view;
		this.options = options;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const chrome = new FramedComponent(
			{ render: (contentWidth) => this.renderContent(contentWidth), invalidate() {} },
			"header",
			() => color(this.view.status),
		);
		// The gutter reserves its own cells; clip defensively for one-cell terminals.
		return chrome.render(width).map((line) => truncateToWidth(line, width, ""));
	}
	private renderContent(width: number): string[] {
		// The chrome clamps to ≥1 already; keep the padding arithmetic safe regardless.
		if (!Number.isFinite(width) || width < 1) return [];
		const view = this.view;
		const theme = this.theme;
		const options = this.options;
		// The native dot/rail replaces the default one-cell custom-message inset.
		// Additional configured padding stays inside the chrome, never shifting the dot.
		const padding = Math.min(Math.max(0, Math.floor(options.outputPad || 0) - 1), Math.floor((width - 1) / 2));
		const inner = width - padding * 2;
		const indent = inner >= 3 ? "  " : "";
		const bodyWidth = Math.max(1, inner - indent.length);
		const lines: string[] = [];
		const status = view.status ? statusName(view.status) : "Result received";
		lines.push(
			`${theme.fg("toolTitle", theme.bold(view.label ?? "Notification"))}${theme.fg("muted", ` · Background ${status.toLowerCase()}${view.duration ? ` · ${view.duration}` : ""}`)}${view.id ? theme.fg("dim", ` · ${shortId(view.id)}`) : ""}`,
		);
		const summary = view.title?.split("\n").find((line) => line.trim()) ?? view.title;
		if (!options.expanded) {
			if (summary) lines.push(theme.fg("toolOutput", summary));
			if (view.diagnostic) lines.push(theme.fg(color(view.status), view.diagnostic));
		} else {
			if (view.truncated) {
				lines.push(theme.fg("warning", "The saved result is truncated; this is not the complete original output."));
			}
			const section = (title: string, text: string, limit: number, tail = false, error = false) => {
				lines.push("", theme.fg("muted", theme.bold(title)));
				const rendered = wrapTextWithAnsi(text, bodyWidth).map((line) =>
					theme.fg(error ? "error" : "toolOutput", line),
				);
				const omitted = Math.max(0, rendered.length - limit);
				const selected = tail ? rendered.slice(-limit) : rendered.slice(0, limit);
				if (tail && omitted) lines.push(theme.fg("dim", `${indent}… ${omitted} earlier display lines omitted`));
				for (const line of selected) lines.push(indent + line);
				if (!tail && omitted) lines.push(theme.fg("dim", `${indent}… ${omitted} more display lines omitted`));
			};
			if (view.output === undefined) section("Details", view.body || "No text result.", 36);
			else {
				if (view.input) section(view.input.label, view.input.text, 8);
				else if (view.title) section("Task", view.title, 4);
				if (view.facts.length) {
					const width = Math.max(...view.facts.map(([label]) => label.length)) + 1;
					section("Details", view.facts.map(([label, value]) => `${label.padEnd(width)}${value}`).join("\n"), 8);
				}
				section(
					view.status === "failed" || view.status === "timeout" ? "Error" : "Result",
					view.diagnostic ?? status,
					4,
					false,
					view.status === "failed",
				);
				section("Output", !view.output.trim() ? "No output." : view.output, OUTPUT_ROWS, !view.report);
				if (view.path) section("Log", view.path, 4);
			}
			if (view.id) {
				lines.push("", ...wrapTextWithAnsi(`Task ID: ${view.id}`, inner).map((line) => theme.fg("dim", line)));
			}
			lines.push(theme.fg("dim", "Preview of the saved result."));
		}
		const bounded =
			lines.length > CARD_ROWS
				? [
						...lines.slice(0, CARD_ROWS - 1),
						theme.fg("dim", "… card shortened; use tasks read for retained output"),
					]
				: lines;
		return bounded.map((line) => " ".repeat(padding) + truncateToWidth(line, inner, "…") + " ".repeat(padding));
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
			body: "The saved notification could not be interpreted. Its original message remains in session history.",
			truncated: false,
			facts: [],
		};
	}
	return new CompletionCard(view, options, theme);
}
