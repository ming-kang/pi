/** Transcript rendering for the native tasks tool: its call/result rows, dispatched on action. */

import { type Component, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { formatDuration } from "../../../core/tasks/format.ts";
import { clampWaitMs, type TasksInput } from "../../../core/tools/tasks/schema.ts";
import type { TasksDetails } from "../../../core/tools/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import type { Theme } from "../theme/theme.ts";
import { exitSuffix, statusColor, statusGlyph, statusName } from "./task-view.ts";
import { fileNameOf } from "./text.ts";

/** Arguments arrive incrementally, so `action` may not be valid yet. */
type TasksRenderInput = Omit<TasksInput, "action"> & { action?: string };

/** Cap for expanded transcript views of tool-result text (already bounded at the source). */
const RESULT_EXPAND_LIMIT = 4000;
/** Live pending-wait line refresh cadence; the first settled render clears the timer. */
const WAIT_REFRESH_MS = 1000;

/** Per-call live-refresh state owned by the shell's render context. */
export interface TasksRenderState {
	dispose?: () => void;
	refreshTimer?: ReturnType<typeof setTimeout>;
	/** First pending render of a wait call; anchors the elapsed display. */
	waitStartedAt?: number;
}

/**
 * Arm a one-shot 1s refresh while a wait call is pending, clear it once
 * settled. The timer fires → context.invalidate() → renderCall re-runs →
 * re-arms, so at most one armed timer exists per tool row. Unref'd: it can
 * never hold the process open.
 */
export function scheduleWaitRefresh(context: ToolRenderContext<TasksRenderState>, pending: boolean): void {
	const state = context.state;
	if (state === undefined) return; // Standalone render without shell state: nothing to schedule.
	if (pending) {
		state.dispose = () => scheduleWaitRefresh(context, false);
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
}

/** Keep the END of oversized text — that is where the outcome lives. */
function capForTranscript(text: string, limit: number): string {
	return text.length > limit ? `…${text.slice(-limit)}` : text;
}

// ── tool call ─────────────────────────────────────────────────────────────

export function renderTasksCall(
	args: TasksRenderInput,
	theme: Theme,
	context: ToolRenderContext<TasksRenderState>,
): Component {
	switch (args.action) {
		case "read": {
			const mode = args.mode ?? "tail";
			const size = args.bytes !== undefined ? ` ${formatSize(args.bytes)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("tasks read "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ` ${mode}${size}`)}`,
				0,
				0,
			);
		}
		case "wait":
			return renderWaitCall(args, theme, context);
		case "kill":
			return new Text(
				`${theme.fg("toolTitle", theme.bold("tasks kill "))}${theme.fg("accent", args.taskId ?? "")}`,
				0,
				0,
			);
		case "list":
			return new Text(theme.fg("toolTitle", theme.bold("tasks list")), 0, 0);
		default: {
			const action = typeof args.action === "string" ? ` ${theme.fg("dim", args.action)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("tasks"))}${action}`, 0, 0);
		}
	}
}

/**
 * Pending wait call: elapsed/wait-window, refreshed once per second by
 * scheduleWaitRefresh until the result settles and takes over the row.
 */
function renderWaitCall(args: TasksRenderInput, theme: Theme, context: ToolRenderContext<TasksRenderState>): Component {
	const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
	// isPartial alone means "not settled", which also covers argument streaming
	// and replayed history rows that never settle; executionStarted narrows it to
	// a call that is actually running. The live display also needs shell-owned
	// state; without it (standalone renders) fall back to the static line.
	const pending =
		context.executionStarted === true &&
		context.isPartial === true &&
		context.state !== undefined &&
		taskId.length > 0;
	scheduleWaitRefresh(context, pending);
	if (!pending) {
		const ms = args.waitMs !== undefined ? ` ${formatDuration(clampWaitMs(args.waitMs))}` : "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("tasks wait "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", ms)}`,
			0,
			0,
		);
	}
	const state = context.state;
	if (state.waitStartedAt === undefined) state.waitStartedAt = Date.now();
	const elapsed = `waiting ${formatDuration(Date.now() - state.waitStartedAt)}/${formatDuration(clampWaitMs(args.waitMs))}`;
	return new Text(
		`${theme.fg("toolTitle", theme.bold("tasks wait "))}${theme.fg("accent", taskId)} ${theme.fg("muted", elapsed)}`,
		0,
		0,
	);
}

// ── tool result ───────────────────────────────────────────────────────────

export function renderTasksResult(
	result: AgentToolResult<TasksDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<TasksRenderState>,
): Component {
	// Results are always settled today; clear defensively so no live-refresh
	// timer can outlive its row if a host ever streams partial results.
	if (context.args?.action === "wait" && !options.isPartial) scheduleWaitRefresh(context, false);
	const details = result.details;
	// Results from older tool versions, such as `bg create`, keep their saved text.
	const summary = details && !context.isError ? resultSummaryLine(details, theme, options.expanded) : undefined;
	if (summary === undefined) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		return new Text(theme.fg("toolOutput", text.trimEnd()), 0, 0);
	}

	const container = new Container();
	container.addChild(new TruncatedText(summary, 1, 0));
	if (options.expanded) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("toolOutput", capForTranscript(text, RESULT_EXPAND_LIMIT).trimEnd()), 1, 0));
	}
	return container;
}

function resultSummaryLine(details: TasksDetails, theme: Theme, expanded: boolean): string | undefined {
	// Collapsed rows stay compact with the log's file name; the full path
	// (context-relevant, human-rarely) shows when expanded.
	const shownPath = (path: string) => (expanded ? path : fileNameOf(path));
	switch (details.action) {
		case "read": {
			const size =
				details.sliceBytes !== details.totalBytes
					? `${details.mode} ${formatSize(details.sliceBytes)} of ${formatSize(details.totalBytes)}`
					: formatSize(details.totalBytes);
			return `${theme.fg("muted", "→ ")}${theme.fg("accent", details.taskId)}${theme.fg("muted", `${details.status ? ` ${statusName(details.status)} ·` : ""} ${size}${details.outputPath ? ` · ${shownPath(details.outputPath)}` : ""}`)}`;
		}
		case "wait": {
			if (details.timedOut) {
				return `${theme.fg(statusColor(details.status), statusGlyph(details.status))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${statusName(details.status)} · wait ended after ${formatDuration(details.waitedMs)} · ${formatSize(details.totalBytes)}`)}`;
			}
			const exit = exitSuffix(details.exitCode, ", ");
			return `${theme.fg(statusColor(details.status), statusGlyph(details.status))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${statusName(details.status)}${exit} · waited ${formatDuration(details.waitedMs)} · +${formatSize(details.deltaBytes)}`)}`;
		}
		case "kill": {
			const status = details.status ?? (details.requested ? "stopping" : "cancelled");
			return `${theme.fg(statusColor(status), statusGlyph(status))} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${statusName(status)}${details.requested ? " · cancellation requested" : ""}`)}`;
		}
		case "list": {
			const hidden = details.hidden > 0 ? ` · ${details.hidden} more finished` : "";
			const omitted = details.foregroundOmitted ? ` · ${details.foregroundOmitted} foreground omitted` : "";
			return theme.fg("muted", `${details.running} running · ${details.finished} finished${hidden}${omitted}`);
		}
		default:
			return undefined;
	}
}
