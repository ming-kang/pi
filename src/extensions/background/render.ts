/**
 * Transcript rendering for the background extension: tool call/result rows
 * and the completion-notification message. Style follows the built-in bash
 * presentation: a `$` prompt row with an `&` marker for the background call.
 */

import { type Component, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	MessageRenderOptions,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { BgBashDetails, BgBashInput, BgKillInput, BgLogsInput, BgNotificationDetails } from "./index.ts";
import type { BgTaskStatus } from "./registry.ts";

const COMMAND_PREVIEW_LIMIT = 120;
const NOTIFY_TAIL_LIMIT = 4000;

function bgPrompt(theme: Theme): string {
	return theme.fg("toolTitle", theme.bold("$ "));
}

function firstNonEmptyLine(command: string): string {
	const line = command.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? command;
	return line.trim();
}

function timeoutSuffix(timeout: number | undefined, theme: Theme): string {
	return timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
}

function statusGlyph(status: BgTaskStatus): string {
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

function statusColor(status: BgTaskStatus): "success" | "error" | "warning" | "muted" | "accent" {
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

export function renderBgBashCall(args: BgBashInput, theme: Theme, context: ToolRenderContext): Component {
	const command = firstNonEmptyLine(args.command);
	const body = highlightCode(command, "bash").join("\n");
	const suffix = theme.fg("muted", " &") + timeoutSuffix(args.timeout, theme);
	if (!context.expanded && args.command.split(/\r?\n/).filter((line) => line.trim()).length > 1) {
		const hidden = args.command.split(/\r?\n/).filter((line) => line.trim()).length - 1;
		const more = theme.fg("muted", ` (+${hidden} line${hidden === 1 ? "" : "s"})`);
		return new Text(`${bgPrompt(theme)}${body}${suffix}${more}`, 0, 0);
	}
	return new Text(`${bgPrompt(theme)}${body}${suffix}`, 0, 0);
}

export function renderBgBashResult(
	result: AgentToolResult<BgBashDetails | undefined>,
	_options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	if (context.isError) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		return new Text(theme.fg("toolOutput", text.trimEnd()), 0, 0);
	}
	const details = result.details;
	if (!details) return new Text(theme.fg("toolOutput", "Background task started."), 0, 0);
	const line = `${theme.fg("muted", "→ task ")}${theme.fg("accent", details.taskId)}${theme.fg(
		"muted",
		` started · ${details.outputPath}`,
	)}`;
	return new Text(line, 0, 0);
}

export function renderBgLogsCall(args: BgLogsInput, theme: Theme): Component {
	const mode = args.mode ?? "tail";
	const size = args.bytes !== undefined ? ` ${args.bytes}B` : "";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("bg logs "))}${theme.fg("accent", args.taskId)}${theme.fg("muted", ` ${mode}${size}`)}`,
		0,
		0,
	);
}

export function renderBgKillCall(args: BgKillInput, theme: Theme): Component {
	return new Text(`${theme.fg("toolTitle", theme.bold("bg kill "))}${theme.fg("accent", args.taskId)}`, 0, 0);
}

/** One-line summary of a finished task, shared by the notification renderer. */
function taskSummaryLine(details: BgNotificationDetails, theme: Theme): string {
	const runtime = formatRuntimeMs(details.runtimeMs);
	const exit = details.exitCode !== undefined && details.exitCode !== null ? `, exit ${details.exitCode}` : "";
	const outcome = theme.fg(statusColor(details.status), `${details.status}${exit} in ${runtime}`);
	const glyph = theme.fg(statusColor(details.status), statusGlyph(details.status));
	return `${glyph} ${theme.fg("accent", details.taskId)} ${truncateCommand(details.command)} ${theme.fg("muted", `— ${outcome}`)}`;
}

function truncateCommand(command: string): string {
	const characters = [...firstNonEmptyLine(command)];
	return characters.length <= COMMAND_PREVIEW_LIMIT
		? characters.join("")
		: `${characters.slice(0, COMMAND_PREVIEW_LIMIT - 1).join("")}…`;
}

function formatRuntimeMs(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

/**
 * Collapsed: status glyph, task id, command, and outcome on one line, output
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
		const tail =
			details.tailText.length > NOTIFY_TAIL_LIMIT
				? `${details.tailText.slice(0, NOTIFY_TAIL_LIMIT)}…`
				: details.tailText;
		const truncatedNote = details.tailTruncated
			? `\n[showing tail of ${details.totalBytes} bytes; full output: ${details.outputPath}]`
			: "";
		container.addChild(
			new Text(`${theme.fg("toolOutput", tail.trimEnd())}${theme.fg("muted", truncatedNote)}`, 1, 0),
		);
	}
	return container;
}
