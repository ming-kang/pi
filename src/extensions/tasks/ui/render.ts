/** Transcript rendering for the native tasks tool: its call/result rows, dispatched on action. */

import { type Component, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { TaskStatus } from "../../../core/tasks/types.ts";
import { formatSize } from "../../../core/tools/truncate.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { TasksInput } from "../tool/schema.ts";
import type { TasksDetails } from "../tool/types.ts";
import { statusName, statusView } from "./status.ts";
import { fileNameOf } from "./text.ts";

/** Arguments arrive incrementally, so `action` may not be valid yet. */
type TasksRenderInput = Omit<TasksInput, "action"> & { action?: string };

/** Cap for expanded transcript views of tool-result text (already bounded at the source). */
const RESULT_EXPAND_LIMIT = 4000;

/** Keep the end that was read: a report's summary or a log's outcome. */
function capForTranscript(text: string, limit: number, mode: "head" | "tail" = "tail"): string {
	if (text.length <= limit) return text;
	return mode === "head" ? `${text.slice(0, limit)}…` : `…${text.slice(-limit)}`;
}

// ── tool call ─────────────────────────────────────────────────────────────

export function renderTasksCall(args: TasksRenderInput, theme: Theme, _context: ToolRenderContext): Component {
	switch (args.action) {
		case "read": {
			// The default end depends on the task's output kind, which the call does not carry.
			const mode = args.mode ? ` ${args.mode}` : "";
			const size = args.bytes !== undefined ? ` ${formatSize(args.bytes)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("tasks read "))}${theme.fg("accent", args.taskId ?? "")}${theme.fg("muted", `${mode}${size}`)}`,
				0,
				0,
			);
		}
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

// ── tool result ───────────────────────────────────────────────────────────

export function renderTasksResult(
	result: AgentToolResult<TasksDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const details = result.details;
	// Results from older tool versions, such as `bg create` or `wait`, keep their saved text.
	const summary = details && !context.isError ? resultSummaryLine(details, theme, options.expanded) : undefined;
	if (summary === undefined || details === undefined) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		return new Text(theme.fg("toolOutput", text.trimEnd()), 0, 0);
	}

	const container = new Container();
	container.addChild(new TruncatedText(summary, 1, 0));
	if (options.expanded) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		const mode = details.action === "read" ? details.mode : undefined;
		container.addChild(new Text("", 0, 0));
		container.addChild(
			new Text(theme.fg("toolOutput", capForTranscript(text, RESULT_EXPAND_LIMIT, mode).trimEnd()), 1, 0),
		);
	}
	return container;
}

function resultSummaryLine(details: TasksDetails, theme: Theme, expanded: boolean): string | undefined {
	// Collapsed rows stay compact with the log's file name; the full path
	// (context-relevant, human-rarely) shows when expanded.
	const shownPath = (path: string) => (expanded ? path : fileNameOf(path));
	const mark = (status: TaskStatus) => {
		const { color, glyph } = statusView(status);
		return theme.fg(color, glyph);
	};
	switch (details.action) {
		case "read": {
			const size =
				details.sliceBytes !== details.totalBytes
					? `${details.mode} ${formatSize(details.sliceBytes)} of ${formatSize(details.totalBytes)}`
					: formatSize(details.totalBytes);
			return `${theme.fg("muted", "→ ")}${theme.fg("accent", details.taskId)}${theme.fg("muted", `${details.status ? ` ${statusName(details.status)} ·` : ""} ${size}${details.outputPath ? ` · ${shownPath(details.outputPath)}` : ""}`)}`;
		}
		case "kill": {
			const status = details.status ?? (details.requested ? "stopping" : "cancelled");
			return `${mark(status)} ${theme.fg("accent", details.taskId)}${theme.fg("muted", ` ${statusName(status)}${details.requested ? " · cancellation requested" : ""}`)}`;
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
