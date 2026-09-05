/** Human-facing completion cards. The persisted model message remains untouched. */
import {
	type Component,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MessageRenderOptions } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

const SOURCE_LIMIT = 64 * 1024;
const CARD_ROWS = 128;
const OUTPUT_ROWS = 20;
const REPORT_ROWS = 24;

type Status = "completed" | "partial" | "failed" | "cancelled" | "timeout";
interface WorkerReport {
	index: number;
	description: string;
	profile: string;
	status: string;
	report: string;
}
interface CompletionView {
	kind?: "bash" | "subagent";
	status?: Status;
	id?: string;
	title?: string;
	command?: string;
	path?: string;
	diagnostic?: string;
	body: string;
	workers?: WorkerReport[];
	ambiguous?: boolean;
	truncated: boolean;
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripTerminalSequences(text)).replace(/\r\n?/g, "\n");
}

function savedText(message: CustomMessage<unknown>): { text: string; clipped: boolean } {
	const content = message.content;
	let text = "";
	let clipped = false;
	if (typeof content === "string") {
		text = content.slice(0, SOURCE_LIMIT);
		clipped = content.length > SOURCE_LIMIT;
	} else if (Array.isArray(content)) {
		for (const block of content) {
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

const WORKER_HEADER = /^### ([1-8])\. (.+) \((explorer|general)\) — (completed|failed|aborted|queued|running)$/;

/** Only split the known, consecutive envelope headings, outside Markdown fences. */
function workerReports(body: string, expected: number): WorkerReport[] | undefined {
	const lines = body.split("\n");
	const first = WORKER_HEADER.exec(lines[0] ?? "");
	if (!first || first[1] !== "1") return undefined;
	const headings: { at: number; end: number; match: RegExpExecArray }[] = [{ at: 0, end: lines.length, match: first }];
	let fence: { char: string; length: number } | undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker) {
			const token = marker[1]!;
			if (!fence) fence = { char: token[0]!, length: token.length };
			else if (token[0] === fence.char && token.length >= fence.length && !marker[2]?.trim()) fence = undefined;
			continue;
		}
		if (fence) continue;
		const match = WORKER_HEADER.exec(line);
		if (!match) continue;
		if (
			Number(match[1]) !== headings.length + 1 ||
			lines[i - 1] !== "" ||
			lines[i - 2] !== "---" ||
			lines[i - 3] !== ""
		)
			return undefined;
		headings[headings.length - 1]!.end = i - 3;
		headings.push({ at: i, end: lines.length, match });
	}
	if (headings.length !== expected) return undefined;
	return headings.map(({ at, end, match }) => ({
		index: Number(match[1]),
		description: match[2]!,
		profile: match[3]!,
		status: match[4]!,
		report: lines
			.slice(at + 1, end)
			.join("\n")
			.trim(),
	}));
}

function finalDiagnostic(body: string, status: Status): string | undefined {
	const last = body.trimEnd().split("\n").at(-1)?.trim() ?? "";
	if (status === "timeout" && /^Command timed out after \d+(?:\.\d+)? seconds$/.test(last)) return last;
	if (status === "cancelled" && last === "Command aborted") return last;
	if (
		status === "failed" &&
		/^(?:Command exited with code -?\d+|Command terminated without an exit code|Background command exceeded the 20 MiB output limit)$/.test(
			last,
		)
	)
		return last;
	return undefined;
}

function parseCompletion(message: CustomMessage<unknown>): CompletionView {
	const { text, clipped } = savedText(message);
	const truncated = clipped || /\[(?:Notification truncated;|Output truncated[:.])/.test(text);
	const fallback: CompletionView = { body: text, truncated };
	const lines = text.split("\n");
	const header =
		/^Background (bash|subagent) ([\w-]{1,160}): (completed|partial|failed|cancelled|timeout) — (.*)$/.exec(
			lines[0] ?? "",
		);
	if (!header) return fallback;
	const details = message.details;
	const savedId = details && typeof details === "object" && "taskId" in details ? details.taskId : undefined;
	if (typeof savedId === "string" && savedId !== header[2]) return fallback;
	const kind = header[1] as "bash" | "subagent";
	const status = header[3] as Status;
	const view: CompletionView = {
		kind,
		status,
		id: header[2],
		title: header[4],
		body: lines.slice(1).join("\n").trim(),
		truncated,
	};
	if (kind === "subagent") {
		const count = /^Subagent · ([1-8]) tasks$/.exec(view.title ?? "");
		if (lines[1] === "") {
			view.body = lines.slice(2).join("\n").trim();
			if (count) view.workers = workerReports(view.body, Number(count[1]));
		}
		return view;
	}
	// Titles can contain newlines. A path inside a command is ambiguous: don't guess.
	const boundaries: number[] = [];
	let titleBytes = Buffer.byteLength(view.title ?? "");
	for (let i = 1; i < lines.length && titleBytes <= 1024; i++) {
		if (/^Output: (?:[A-Za-z]:[\\/]|\/|\\\\)/.test(lines[i]!)) boundaries.push(i);
		titleBytes += 1 + Buffer.byteLength(lines[i]!);
	}
	if (boundaries.length === 1) {
		const boundary = boundaries[0]!;
		view.command = [view.title, ...lines.slice(1, boundary)].join("\n").replace(/^(?:bash|powershell):\s?/i, "");
		view.path = lines[boundary]!.slice("Output: ".length);
		view.body = lines
			.slice(boundary + 1)
			.join("\n")
			.trimEnd();
	} else if (!boundaries.length && lines[1] === "") {
		view.command = (view.title ?? "").replace(/^(?:bash|powershell):\s?/i, "");
		view.body = lines.slice(2).join("\n").trimEnd();
	} else {
		view.ambiguous = true;
		view.body = text;
	}
	if (!view.ambiguous) {
		view.diagnostic = finalDiagnostic(view.body, status);
		if (view.diagnostic) view.body = view.body.trimEnd().slice(0, -view.diagnostic.length).trimEnd();
	}
	return view;
}

function workerFailure(worker: WorkerReport): { reason: string; partial: string } | undefined {
	if (worker.status !== "failed" && worker.status !== "aborted") return undefined;
	const failure = /^(Subagent failed|Subagent aborted)(?:: |\.)([\s\S]*)$/.exec(worker.report);
	if (!failure) return undefined;
	const [reason = "", ...partial] = failure[2]!.split("\n\nPartial report:\n");
	return { reason: reason.trim() || statusName(worker.status), partial: partial.join("\n\nPartial report:\n") };
}

function color(status: string | undefined): "success" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "partial" || status === "cancelled" || status === "aborted" || status === "timeout") return "warning";
	return "muted";
}
function statusName(status: string): string {
	return status === "timeout" ? "Timed out" : status[0]!.toUpperCase() + status.slice(1);
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
		const view = this.view;
		const theme = this.theme;
		const options = this.options;
		const padding = Math.min(Math.max(0, Math.floor(options.outputPad || 0)), Math.floor((width - 1) / 2));
		const inner = width - padding * 2;
		const rail = inner >= 4 ? "│ " : "";
		const bodyWidth = Math.max(1, inner - rail.length);
		const lines: string[] = [];
		const status = view.status ? statusName(view.status) : "Result received";
		const kind =
			view.kind === "subagent"
				? "Subagent"
				: view.kind === "bash"
					? /^powershell:/i.test(view.title ?? "")
						? "PowerShell"
						: "Bash"
					: "Notification";
		const glyph = view.status === "completed" ? "✓" : view.status === "failed" ? "×" : view.status ? "○" : "·";
		const expandKey = keyLabel("app.tools.expand");
		lines.push(
			`${theme.fg(color(view.status), `${glyph} ${kind} · ${status}`)}${view.id ? theme.fg("muted", ` · ${shortId(view.id)}`) : ""}${!options.expanded && expandKey ? theme.fg("dim", ` · ${expandKey} details`) : ""}`,
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
			else if (view.kind === "bash" && view.status === "failed" && !view.ambiguous) {
				const last = view.body.trimEnd().split("\n").at(-1)?.trim();
				if (last) lines.push(theme.fg("muted", `Last output: ${last}`));
			}
			const problem = view.workers?.find((worker) => workerFailure(worker));
			if (problem) {
				const failure = workerFailure(problem)!;
				lines.push(theme.fg(color(problem.status), `#${problem.index}: ${failure.reason.split("\n")[0]}`));
			}
		} else {
			if (view.truncated) {
				lines.push(
					theme.fg("warning", "The saved notification is truncated; this is not the complete original output."),
				);
			}
			const section = (
				title: string,
				text: string,
				limit: number,
				markdown = false,
				tail = false,
				error = false,
			) => {
				lines.push("", theme.fg("accent", theme.bold(title)));
				const rendered = markdown
					? new Markdown(text, 0, 0, getMarkdownTheme()).render(bodyWidth)
					: wrapTextWithAnsi(text, bodyWidth).map((line) => theme.fg(error ? "error" : "toolOutput", line));
				const omitted = Math.max(0, rendered.length - limit);
				const selected = tail ? rendered.slice(-limit) : rendered.slice(0, limit);
				if (tail && omitted) lines.push(theme.fg("dim", `${rail}… ${omitted} earlier display lines omitted`));
				for (const line of selected) lines.push(theme.fg("border", rail) + line);
				if (!tail && omitted) lines.push(theme.fg("dim", `${rail}… ${omitted} more display lines omitted`));
			};
			if (view.kind === "bash" && !view.ambiguous) {
				if (view.command) section("Command", view.command, 8);
				section(
					view.status === "failed" || view.status === "timeout" ? "Error" : "Result",
					view.diagnostic ?? status,
					4,
					false,
					false,
					view.status === "failed",
				);
				section(
					"Output",
					view.body === "(no output)" || !view.body.trim() ? "No output." : view.body,
					OUTPUT_ROWS,
					false,
					true,
				);
				if (view.path) section("Log", view.path, 4);
			} else if (view.workers) {
				const reportBudget = Math.min(REPORT_ROWS, Math.max(6, Math.floor(72 / view.workers.length)));
				for (const worker of view.workers) {
					lines.push(
						"",
						`${theme.fg(color(worker.status), `${worker.status === "completed" ? "✓" : worker.status === "failed" ? "×" : "○"} #${worker.index} ${statusName(worker.profile)}`)}${theme.fg("muted", ` · ${statusName(worker.status)}`)}`,
					);
					lines.push(theme.fg("muted", `Task: ${worker.description}`));
					const failure = workerFailure(worker);
					if (failure) {
						section("Reason", failure.reason, 2, false, false, worker.status === "failed");
						if (failure.partial) section("Partial report", failure.partial, Math.max(3, reportBudget - 6), true);
					} else
						section(
							"Report",
							worker.report === "(Subagent completed but returned no output.)"
								? "No report returned."
								: worker.report || "No report returned.",
							reportBudget,
							true,
						);
				}
			} else {
				section(
					view.ambiguous ? "Saved details (format ambiguous)" : "Details",
					view.body || "No text result.",
					36,
					view.kind !== "bash",
				);
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
		view = parseCompletion(message);
	} catch {
		view = {
			body: "The saved notification could not be interpreted. Its original message remains in session history.",
			truncated: false,
		};
	}
	return new CompletionCard(view, options, theme);
}
