/** Human-facing completion cards. The persisted context message remains untouched. */
import { type Component, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { runtimeLabel } from "../../../core/tasks/format.ts";
import { readTaskCompletion } from "../../../core/tasks/presentation.ts";
import type { TaskTerminalStatus } from "../../../core/tasks/types.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { type StatusMarkerColor, statusMarker } from "../components/status-marker.ts";
import type { Theme } from "../theme/theme.ts";
import { FramedComponent } from "../tool-view/style.ts";
import { statusName } from "./task-view.ts";

const SOURCE_LIMIT = 64 * 1024;
const CARD_ROWS = 128;
const OUTPUT_ROWS = 20;
const SHELL_NAMES: Record<string, string> = { bash: "Bash", powershell: "PowerShell" };

interface CompletionView {
	title?: string;
	duration?: string;
	exitCode?: number | null;
	kind?: string;
	status?: TaskTerminalStatus;
	id?: string;
	command?: string;
	cwd?: string;
	path?: string;
	diagnostic?: string;
	/** Undefined for an unreadable message, whose saved content is shown instead. */
	output?: string;
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
	const snapshot = readTaskCompletion(message.details);
	if (!snapshot) {
		const { text, clipped } = savedText(message);
		return { body: text, truncated: clipped };
	}
	return {
		title: clean(snapshot.title),
		duration: runtimeLabel(snapshot),
		kind: snapshot.kind,
		status: snapshot.status,
		id: clean(snapshot.taskId),
		exitCode: snapshot.exitCode,
		command: snapshot.command === undefined ? undefined : clean(snapshot.command.text),
		cwd: snapshot.cwd === undefined ? undefined : clean(snapshot.cwd),
		path: snapshot.outputPath === undefined ? undefined : clean(snapshot.outputPath),
		diagnostic: snapshot.error === undefined ? undefined : clean(snapshot.error),
		output: clean(snapshot.output.text),
		body: "",
		truncated: snapshot.output.truncated || snapshot.command?.truncated === true,
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
		const kind = view.kind === undefined ? "Notification" : (SHELL_NAMES[view.kind] ?? view.kind);
		lines.push(
			`${theme.fg("toolTitle", theme.bold(kind))}${theme.fg("muted", ` · Background ${status.toLowerCase()}${view.duration ? ` · ${view.duration}` : ""}`)}${view.id ? theme.fg("dim", ` · ${shortId(view.id)}`) : ""}`,
		);
		const summary = view.command ? `$ ${view.command.split("\n")[0]}` : view.title;
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
				if (view.command) section("Command", view.command, 8);
				else if (view.title) section("Task", view.title, 4);
				if (view.cwd) section("Directory", view.cwd, 2);
				section(
					view.status === "failed" || view.status === "timeout" ? "Error" : "Result",
					`${view.diagnostic ?? status}${view.exitCode !== undefined ? ` · ${view.exitCode === null ? "terminated by signal" : `exit ${view.exitCode}`}` : ""}`,
					4,
					false,
					view.status === "failed",
				);
				section("Output", !view.output.trim() ? "No output." : view.output, OUTPUT_ROWS, true);
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
		};
	}
	return new CompletionCard(view, options, theme);
}
