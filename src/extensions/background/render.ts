/**
 * Transcript rendering for the background extension: the single bg tool's
 * call/result rows (dispatched on action) and the completion-notification
 * message. Style follows the built-in bash presentation: a `$` prompt row
 * with an `&` marker for the background call.
 */

import { type Component, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	MessageRenderOptions,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { BgCreateInput, BgDetails, BgInput, BgNotificationDetails } from "./index.ts";
import { type BgTaskStatus, firstCommandLine, formatDuration } from "./registry.ts";

const COMMAND_PREVIEW_LIMIT = 120;
const NOTIFY_TAIL_LIMIT = 4000;
/** Cap for expanded transcript views of tool-result text (already bounded at the source). */
const RESULT_EXPAND_LIMIT = 4000;

function bgPrompt(theme: Theme): string {
	return theme.fg("toolTitle", theme.bold("$ "));
}

function timeoutSuffix(timeout: number | undefined, theme: Theme): string {
	return timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
}

/** Keep the END of oversized text — that is where the outcome lives. */
function capForTranscript(text: string, limit: number): string {
	return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function statusGlyph(status: BgTaskStatus, stalled?: boolean): string {
	if (stalled) return "…";
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
		case "timeout":
			return "✗";
		case "killed":
			return "○";
		default:
			return "●";
	}
}

export function statusColor(status: BgTaskStatus, stalled?: boolean): "success" | "error" | "warning" | "accent" {
	if (stalled) return "warning";
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "timeout":
		case "killed":
			return "warning";
		default:
			return "accent";
	}
}

/** First command line truncated to a visible-character budget with an ellipsis. */
export function commandLabel(command: string, width: number): string {
	const characters = [...firstCommandLine(command)];
	return characters.length <= width ? characters.join("") : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}

// ── tool call ─────────────────────────────────────────────────────────────

export function renderBgCall(args: BgInput, theme: Theme, context: ToolRenderContext): Component {
	switch (args.action) {
		case "create":
			return renderCreateCall(args as BgCreateInput, theme, context);
		case "read": {
			const mode = args.mode ?? "tail";
			const size = args.bytes !== undefined ? ` ${formatSize(args.bytes)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg read "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ` ${mode}${size}`)}`,
				0,
				0,
			);
		}
		case "wait": {
			const ms = args.waitMs !== undefined ? ` ${formatDuration(args.waitMs)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg wait "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ms)}`,
				0,
				0,
			);
		}
		case "kill":
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg kill "))}${theme.fg("accent", args.taskId ?? "")}`,
				0,
				0,
			);
		case "list":
			return new Text(theme.fg("toolTitle", theme.bold("bg list")), 0, 0);
	}
}

function renderCreateCall(args: BgCreateInput, theme: Theme, context: ToolRenderContext): Component {
	const lines = args.command.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const label = args.description ? theme.fg("muted", ` · ${args.description}`) : "";
	const suffix = theme.fg("muted", " &") + timeoutSuffix(args.timeout, theme) + label;
	if (context.expanded && lines.length > 1) {
		const body = highlightCode(args.command, "bash").join("\n");
		return new Text(`${bgPrompt(theme)}${body}${suffix}`, 0, 0);
	}
	const body = highlightCode(firstCommandLine(args.command), "bash").join("\n");
	if (lines.length > 1) {
		const hidden = lines.length - 1;
		const more = theme.fg("muted", ` (+${hidden} line${hidden === 1 ? "" : "s"})`);
		return new Text(`${bgPrompt(theme)}${body}${suffix}${more}`, 0, 0);
	}
	return new Text(`${bgPrompt(theme)}${body}${suffix}`, 0, 0);
}

// ── tool result ───────────────────────────────────────────────────────────

export function renderBgResult(
	result: AgentToolResult<BgDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const details = result.details;
	if (context.isError || !details) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		return new Text(theme.fg("toolOutput", text.trimEnd()), 0, 0);
	}

	const container = new Container();
	container.addChild(new TruncatedText(resultSummaryLine(details, theme), 1, 0));
	if (options.expanded) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("toolOutput", capForTranscript(text, RESULT_EXPAND_LIMIT).trimEnd()), 1, 0));
	}
	return container;
}

function resultSummaryLine(details: BgDetails, theme: Theme): string {
	switch (details.action) {
		case "create":
			return `${theme.fg("muted", "→ task ")}${theme.fg("accent", details.taskId)}${theme.fg("muted", ` started · ${details.outputPath}`)}`;
		case "read": {
			const size =
				details.sliceBytes !== details.totalBytes
					? `${details.mode} ${formatSize(details.sliceBytes)} of ${formatSize(details.totalBytes)}`
					: formatSize(details.totalBytes);
			return `${theme.fg("muted", "→ ")}${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${size} · ${details.outputPath}`)}`;
		}
		case "wait": {
			if (details.timedOut) {
				return `${theme.fg(statusColor(details.status), statusGlyph(details.status))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` still running · waited ${formatDuration(details.waitedMs)} · ${formatSize(details.totalBytes)}`)}`;
			}
			const exit = details.exitCode !== undefined && details.exitCode !== null ? `, exit ${details.exitCode}` : "";
			return `${theme.fg(statusColor(details.status), statusGlyph(details.status))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${details.status}${exit} · waited ${formatDuration(details.waitedMs)} · +${formatSize(details.deltaBytes)}`)}`;
		}
		case "kill":
			return `${theme.fg(statusColor("killed"), statusGlyph("killed"))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", " stopped")}`;
		case "list": {
			const hidden = details.hidden > 0 ? ` · ${details.hidden} more finished` : "";
			return theme.fg("muted", `${details.running} running · ${details.finished} finished${hidden}`);
		}
	}
}

// ── completion notification ───────────────────────────────────────────────

/** One-line summary of a finished task, shared by the notification renderer. */
function taskSummaryLine(details: BgNotificationDetails, theme: Theme): string {
	const runtime = formatDuration(details.runtimeMs);
	const exit = details.exitCode !== undefined && details.exitCode !== null ? `, exit ${details.exitCode}` : "";
	if (details.stalled) {
		const glyph = theme.fg("warning", "…");
		const label = details.description
			? `${details.description} (${commandLabel(details.command, 40)})`
			: commandLabel(details.command, COMMAND_PREVIEW_LIMIT);
		return `${glyph} ${theme.fg("accent", details.taskId)} ${label} ${theme.fg("muted", `— waiting for input (${runtime})`)}`;
	}
	const outcome = theme.fg(statusColor(details.status), `${details.status}${exit} in ${runtime}`);
	const glyph = theme.fg(statusColor(details.status), statusGlyph(details.status));
	const label = details.description
		? `${details.description} (${commandLabel(details.command, 40)})`
		: commandLabel(details.command, COMMAND_PREVIEW_LIMIT);
	return `${glyph} ${theme.fg("accent", details.taskId)} ${label} ${theme.fg("muted", `— ${outcome}`)}`;
}

/**
 * Collapsed: status glyph, task id, label, and outcome on one line, output
 * path below. Expanded adds the embedded output tail. Returns undefined for
 * malformed details so the default custom-message rendering takes over.
 */
export function renderBackgroundNotification(
	message: CustomMessage<BgNotificationDetails>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	if (!details || typeof details.taskId !== "string") return undefined;

	const container = new Container();
	container.addChild(new TruncatedText(taskSummaryLine(details, theme), 1, 0));
	container.addChild(new Text(theme.fg("muted", details.outputPath), 1, 0));

	if (details.tailError) {
		container.addChild(new Text(theme.fg("error", `Output unavailable: ${details.tailError}`), 1, 0));
	} else if (options.expanded && details.tailText) {
		container.addChild(new Text("", 0, 0));
		const tail = capForTranscript(details.tailText, NOTIFY_TAIL_LIMIT);
		const truncatedNote = details.tailTruncated
			? `\n[showing tail of ${formatSize(details.totalBytes)} bytes; full output: ${details.outputPath}]`
			: "";
		container.addChild(
			new Text(`${theme.fg("toolOutput", tail.trimEnd())}${theme.fg("muted", truncatedNote)}`, 1, 0),
		);
	}
	if (details.stalled && options.expanded) {
		container.addChild(
			new Text(
				theme.fg(
					"warning",
					"Blocked on interactive input — kill (bg action kill) and re-run with piped input or a non-interactive flag.",
				),
				1,
				0,
			),
		);
	}
	return container;
}
