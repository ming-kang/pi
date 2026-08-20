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
import {
	BG_WAIT_DEFAULT_MS,
	BG_WAIT_MAX_MS,
	BG_WAIT_MIN_MS,
	type BgTaskStatus,
	firstCommandLine,
	formatDuration,
} from "./registry.ts";

const COMMAND_PREVIEW_LIMIT = 120;
const NOTIFY_TAIL_LIMIT = 4000;
/** Cap for expanded transcript views of tool-result text (already bounded at the source). */
const RESULT_EXPAND_LIMIT = 4000;
/** Live pending-wait line refresh cadence; the first settled render clears the timer. */
const WAIT_REFRESH_MS = 1000;

/** Live peek at a waited-on task, fed from the registry by the call renderer. */
export interface BgTaskLive {
	status: BgTaskStatus;
	outputBytes: number;
}

export type WaitLiveProbe = (taskId: string) => BgTaskLive | undefined;

/** Per-call live-refresh state owned by the shell's render context. */
export interface BgRenderState {
	refreshTimer?: ReturnType<typeof setTimeout>;
	/** First pending render of a wait call; anchors the elapsed display. */
	waitStartedAt?: number;
	/** outputBytes snapshot at wait start; anchors the "+new output" display. */
	waitBaselineBytes?: number;
}

/**
 * Arm a one-shot 1s refresh while a wait call is pending, clear it once
 * settled. The timer fires → context.invalidate() → renderCall re-runs →
 * re-arms, so at most one armed timer exists per tool row. Unref'd: it can
 * never hold the process open.
 */
export function scheduleWaitRefresh(context: ToolRenderContext<BgRenderState>, pending: boolean): void {
	const state = context.state;
	if (state === undefined) return; // Standalone render without shell state: nothing to schedule.
	if (pending) {
		if (state.refreshTimer === undefined) {
			state.refreshTimer = setTimeout(() => {
				state.refreshTimer = undefined;
				context.invalidate();
			}, WAIT_REFRESH_MS);
			state.refreshTimer.unref?.();
		}
		return;
	}
	if (state.refreshTimer !== undefined) {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = undefined;
	}
	state.waitStartedAt = undefined;
	state.waitBaselineBytes = undefined;
}

/** Basename of a path, slash-normalized — compact display of output files. */
export function fileNameOf(path: string): string {
	return path.replace(/\\/g, "/").split("/").at(-1) ?? path;
}

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

export function renderBgCall(
	args: BgInput,
	theme: Theme,
	context: ToolRenderContext<BgRenderState>,
	getTaskLive?: WaitLiveProbe,
): Component {
	switch (args.action) {
		case "create":
			return typeof args.command === "string"
				? renderCreateCall(args as BgCreateInput, theme, context)
				: new Text(theme.fg("toolTitle", theme.bold("bg create")), 0, 0);
		case "read": {
			const mode = args.mode ?? "tail";
			const size = args.bytes !== undefined ? ` ${formatSize(args.bytes)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg read "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ` ${mode}${size}`)}`,
				0,
				0,
			);
		}
		case "wait":
			return renderWaitCall(args, theme, context, getTaskLive);
		case "kill":
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bg kill "))}${theme.fg("accent", args.taskId ?? "")}`,
				0,
				0,
			);
		case "list":
			return new Text(theme.fg("toolTitle", theme.bold("bg list")), 0, 0);
		default: {
			// Tool arguments arrive incrementally while the model is still emitting
			// JSON. Keep the call row renderable until `action` becomes valid.
			const action = typeof args.action === "string" ? ` ${theme.fg("dim", args.action)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("bg"))}${action}`, 0, 0);
		}
	}
}

/** Mirror the execution-side clamp so the shown window matches the real one. */
export function clampWaitMs(waitMs: number | undefined): number {
	return Math.min(BG_WAIT_MAX_MS, Math.max(BG_WAIT_MIN_MS, Math.floor(waitMs ?? BG_WAIT_DEFAULT_MS)));
}

/**
 * Pending wait call: elapsed/wait-window and the new-output delta since the
 * wait began, refreshed once per second by scheduleWaitRefresh until the
 * result settles and takes over the row.
 */
function renderWaitCall(
	args: BgInput,
	theme: Theme,
	context: ToolRenderContext<BgRenderState>,
	getTaskLive: WaitLiveProbe | undefined,
): Component {
	const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
	const live = getTaskLive !== undefined && taskId ? getTaskLive(taskId) : undefined;
	// The live display needs shell-owned state; without it (standalone renders)
	// fall back to the static line.
	const pending = context.isPartial === true && context.state !== undefined && taskId.length > 0;
	scheduleWaitRefresh(context, pending);
	if (!pending) {
		const ms = args.waitMs !== undefined ? ` ${formatDuration(clampWaitMs(args.waitMs))}` : "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("bg wait "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ms)}`,
			0,
			0,
		);
	}
	const state = context.state;
	if (state.waitStartedAt === undefined) state.waitStartedAt = Date.now();
	const startedAt = state.waitStartedAt;
	let liveBase: number | undefined;
	if (live) {
		if (state.waitBaselineBytes === undefined) state.waitBaselineBytes = live.outputBytes;
		liveBase = state.waitBaselineBytes;
	}
	const parts = [`waiting ${formatDuration(Date.now() - startedAt)}/${formatDuration(clampWaitMs(args.waitMs))}`];
	if (live && live.status === "running" && liveBase !== undefined && live.outputBytes > liveBase) {
		parts.push(`+${formatSize(live.outputBytes - liveBase)} new output`);
	}
	return new Text(
		`${theme.fg("toolTitle", theme.bold("bg wait "))}${theme.fg("accent", taskId)} ${theme.fg("muted", parts.join(" · "))}`,
		0,
		0,
	);
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
	context: ToolRenderContext<BgRenderState>,
): Component {
	// bg results are always settled today; clear defensively so no live-refresh
	// timer can outlive its row if a host ever streams partial results.
	if (context.args?.action === "wait" && !options.isPartial) scheduleWaitRefresh(context, false);
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
		case "create": {
			const label = details.description ? ` (${details.description})` : "";
			return `${theme.fg("muted", "→ task ")}${theme.fg("accent", `${details.taskId}${label}`)}${theme.fg("muted", ` started · ${details.outputPath}`)}`;
		}
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
	// Collapsed keeps the row compact with the file name; the full path
	// (model-relevant, human-rarely) shows when expanded.
	const shownPath = options.expanded ? details.outputPath : fileNameOf(details.outputPath);
	container.addChild(new Text(theme.fg("muted", shownPath), 1, 0));

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
