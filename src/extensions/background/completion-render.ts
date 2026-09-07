/** Human-facing completion cards. The persisted model message remains untouched. */
import {
	type Component,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readBackgroundCompletion } from "../../core/background/presentation.ts";
import type { BackgroundTerminalStatus } from "../../core/background/types.ts";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { ToolChromeComponent } from "../../modes/interactive/components/tool-chrome.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

const SOURCE_LIMIT = 64 * 1024;
const CARD_ROWS = 128;
const OUTPUT_ROWS = 20;
const REPORT_ROWS = 24;

interface WorkerReport {
	index: number;
	description: string;
	profile: string;
	status: string;
	report: string;
	error?: string;
	truncated: boolean;
}
interface CompletionView {
	kind?: "bash" | "subagent";
	status?: BackgroundTerminalStatus;
	id?: string;
	shell?: string;
	command?: string;
	cwd?: string;
	path?: string;
	diagnostic?: string;
	body: string;
	workers?: WorkerReport[];
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
	const snapshot = readBackgroundCompletion(message.details);
	if (!snapshot) {
		const { text, clipped } = savedText(message);
		return { body: text, truncated: clipped };
	}
	const view: CompletionView = {
		kind: snapshot.kind,
		status: snapshot.status,
		id: clean(snapshot.taskId),
		body: "",
		diagnostic: snapshot.error === undefined ? undefined : clean(snapshot.error),
		truncated: false,
	};
	if (snapshot.kind === "bash") {
		view.shell = snapshot.shell === undefined ? undefined : clean(snapshot.shell);
		view.command = snapshot.command === undefined ? undefined : clean(snapshot.command.text);
		view.cwd = snapshot.cwd === undefined ? undefined : clean(snapshot.cwd);
		view.path = snapshot.outputPath === undefined ? undefined : clean(snapshot.outputPath);
		view.body = clean(snapshot.output.text);
		view.truncated = snapshot.output.truncated || snapshot.command?.truncated === true;
	} else if (snapshot.workers.length) {
		view.workers = snapshot.workers.map((worker, index) => ({
			index: index + 1,
			description: clean(worker.description),
			profile: clean(worker.profile),
			status: clean(worker.status),
			report: clean(worker.report.text),
			error: worker.error === undefined ? undefined : clean(worker.error),
			truncated: worker.report.truncated,
		}));
	} else {
		view.body = clean(snapshot.output?.text ?? "");
		view.truncated = snapshot.output?.truncated ?? false;
	}
	return view;
}

function failedWorker(worker: WorkerReport): boolean {
	return !!worker.error || worker.status === "failed" || worker.status === "aborted" || worker.status === "cancelled";
}

function color(status: string | undefined): "success" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "partial" || status === "cancelled" || status === "aborted" || status === "timeout") return "warning";
	return "muted";
}
function statusName(status: string): string {
	return status === "timeout" ? "Timed out" : status ? status[0]!.toUpperCase() + status.slice(1) : "Unknown";
}
function shortId(id: string): string {
	return id.replace(/^(bash|subagent)-(.{8}).+$/, "$1-$2");
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
		const theme = this.theme;
		const chrome = new ToolChromeComponent(
			{ render: (contentWidth) => this.renderContent(contentWidth), invalidate() {} },
			`${theme.fg(color(this.view.status), "●")} `,
			{ continuationPrefix: theme.fg("dim", "│ "), blankLinePrefix: theme.fg("dim", "│") },
		);
		// Native chrome reserves two cells; clip defensively for one-cell terminals.
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
		const kind =
			view.kind === "subagent"
				? "Subagent"
				: view.kind === "bash"
					? view.shell === "bash"
						? "Bash"
						: view.shell || "Shell"
					: "Notification";
		lines.push(
			`${theme.fg("toolTitle", theme.bold(kind))}${theme.fg("muted", ` · Background ${status.toLowerCase()}`)}${view.id ? theme.fg("dim", ` · ${shortId(view.id)}`) : ""}`,
		);
		if (!options.expanded) {
			if (view.command) lines.push(theme.fg("toolOutput", `$ ${view.command.split("\n")[0]}`));
			else if (view.workers)
				lines.push(
					theme.fg(
						"muted",
						`${view.workers.length} worker${view.workers.length === 1 ? "" : "s"} · reports available`,
					),
				);
			if (view.diagnostic) lines.push(theme.fg(color(view.status), view.diagnostic));
			const problem = view.workers?.find(failedWorker);
			if (problem) {
				lines.push(
					theme.fg(
						color(problem.status),
						`#${problem.index}: ${(problem.error || statusName(problem.status)).split("\n")[0]}`,
					),
				);
			}
		} else {
			if (view.truncated) {
				lines.push(theme.fg("warning", "The saved result is truncated; this is not the complete original output."));
			}
			const section = (
				title: string,
				text: string,
				limit: number,
				markdown = false,
				tail = false,
				error = false,
			) => {
				lines.push("", theme.fg("muted", theme.bold(title)));
				const rendered = markdown
					? new Markdown(text, 0, 0, getMarkdownTheme()).render(bodyWidth)
					: wrapTextWithAnsi(text, bodyWidth).map((line) => theme.fg(error ? "error" : "toolOutput", line));
				const omitted = Math.max(0, rendered.length - limit);
				const selected = tail ? rendered.slice(-limit) : rendered.slice(0, limit);
				if (tail && omitted) lines.push(theme.fg("dim", `${indent}… ${omitted} earlier display lines omitted`));
				for (const line of selected) lines.push(indent + line);
				if (!tail && omitted) lines.push(theme.fg("dim", `${indent}… ${omitted} more display lines omitted`));
			};
			if (view.kind === "subagent" && view.diagnostic)
				section("Group result", view.diagnostic, 4, false, false, view.status === "failed");
			if (view.kind === "bash") {
				if (view.command) section("Command", view.command, 8);
				if (view.cwd) section("Directory", view.cwd, 2);
				section(
					view.status === "failed" || view.status === "timeout" ? "Error" : "Result",
					view.diagnostic ?? status,
					4,
					false,
					false,
					view.status === "failed",
				);
				section("Output", !view.body.trim() ? "No output." : view.body, OUTPUT_ROWS, false, true);
				if (view.path) section("Log", view.path, 4);
			} else if (view.workers) {
				const reportBudget = Math.min(REPORT_ROWS, Math.max(6, Math.floor(72 / view.workers.length)));
				for (const worker of view.workers) {
					lines.push(
						"",
						`${theme.fg(color(worker.status), `${worker.status === "completed" ? "✓" : worker.status === "failed" ? "×" : "○"} #${worker.index} ${statusName(worker.profile)}`)}${theme.fg("muted", ` · ${statusName(worker.status)}`)}`,
					);
					lines.push(theme.fg("muted", `Task: ${worker.description}`));
					if (failedWorker(worker)) {
						section(
							"Reason",
							worker.error || statusName(worker.status),
							2,
							false,
							false,
							worker.status === "failed",
						);
						if (worker.report) section("Partial report", worker.report, Math.max(3, reportBudget - 6), true);
					} else section("Report", worker.report || "No report returned.", reportBudget, true);
					if (worker.truncated) lines.push(theme.fg("warning", "  Saved report truncated."));
				}
			} else {
				section("Details", view.body || "No text result.", 36, true);
			}
			if (view.id) {
				lines.push("", ...wrapTextWithAnsi(`Task ID: ${view.id}`, inner).map((line) => theme.fg("dim", line)));
			}

			lines.push(theme.fg("dim", "Preview of the saved result · /bg has task details while retained."));
		}
		const bounded =
			lines.length > CARD_ROWS
				? [...lines.slice(0, CARD_ROWS - 1), theme.fg("dim", "… card shortened; inspect retained details in /bg")]
				: lines;
		return bounded.map((line) => " ".repeat(padding) + truncateToWidth(line, inner, "…") + " ".repeat(padding));
	}
}

/** Always return a compact, replay-safe component, including for unknown historical formats. */
export function renderBackgroundCompletion(
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
