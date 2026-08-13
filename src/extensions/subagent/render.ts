import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { getSubagentRetryView } from "./retry.ts";
import { statusSummary } from "./runner.ts";
import type { SubagentParams } from "./schema.ts";
import { firstPlainLine, plainLine } from "./text.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentRunStatus, ToolActivity } from "./types.ts";

const TASK_SUMMARY_LIMIT = 72;
const ACTIVITY_SUMMARY_LIMIT = 120;
const ACTIVITY_RESULT_LIMIT = 96;
const RETRY_ERROR_LIMIT = 160;
const FALLBACK_OUTPUT_LIMIT = 4_000;
const ACTIVITY_DURATION_MIN_MS = 10_000;

function truncate(text: string, limit: number): string {
	const characters = [...text];
	return characters.length <= limit ? text : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function taskPrompt(args: SubagentParams, index: number, run: SubagentRunDetails): string {
	return args.tasks[index]?.prompt ?? run.description;
}

function taskSummary(args: SubagentParams, index: number, run: SubagentRunDetails): string {
	const firstLine = firstPlainLine(taskPrompt(args, index, run));
	return truncate(firstLine || plainLine(run.description) || `Task ${index + 1}`, TASK_SUMMARY_LIMIT);
}

function profileLabel(agent: string): string {
	if (agent === "explorer") return "Explorer";
	if (agent === "general") return "General";
	return agent;
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(seconds: number): string {
	const roundedSeconds = Math.round(seconds);
	if (roundedSeconds >= 60) return `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s`;
	return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function elapsed(startedAt: number | undefined, endedAt?: number): string | undefined {
	if (startedAt === undefined) return undefined;
	return formatDuration(Math.max(0, ((endedAt ?? Date.now()) - startedAt) / 1_000));
}

function statusColor(status: SubagentRunStatus): "success" | "error" | "warning" | "accent" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "warning";
		case "running":
			return "accent";
		default:
			return "muted";
	}
}

function statusMarker(status: SubagentRunStatus, theme: Theme): string {
	const glyph =
		status === "completed"
			? "✓"
			: status === "failed"
				? "×"
				: status === "aborted"
					? "■"
					: status === "running"
						? "›"
						: "○";
	return theme.fg(statusColor(status), glyph);
}

function statusWord(status: SubagentRunStatus): string {
	if (status === "completed") return "Completed";
	if (status === "failed") return "Failed";
	if (status === "aborted") return "Aborted";
	if (status === "running") return "Running";
	return "Queued";
}

function retryText(run: SubagentRunDetails): string | undefined {
	const retry = getSubagentRetryView(run);
	if (!retry) return undefined;
	const state =
		retry.remainingSeconds > 0
			? `Retrying (${retry.attempt}/${retry.maxAttempts}) in ${retry.remainingSeconds}s`
			: `Retrying now… (${retry.attempt}/${retry.maxAttempts})`;
	const error = truncate(plainLine(retry.error), RETRY_ERROR_LIMIT);
	return error ? `${state} — ${error}` : state;
}

function runningDetail(run: SubagentRunDetails): string | undefined {
	const retry = retryText(run);
	if (retry) return retry;
	if (run.currentActivity) return truncate(plainLine(run.currentActivity), ACTIVITY_SUMMARY_LIMIT);
	if (run.status === "queued") return "Waiting for a worker slot";
	if (run.status === "running" && run.usage.turns === 0 && run.usage.toolUses === 0) return "Initializing…";
	if (run.status === "running") return "Thinking…";
	if ((run.status === "failed" || run.status === "aborted") && run.error) {
		return truncate(plainLine(run.error), ACTIVITY_RESULT_LIMIT);
	}
	return undefined;
}

function batchMarker(details: SubagentDetails, theme: Theme): string {
	if (details.runs.some((run) => run.status === "failed")) return theme.fg("error", "×");
	if (details.runs.some((run) => run.status === "aborted")) return theme.fg("warning", "■");
	return theme.fg("success", "✓");
}

function progressHeader(details: SubagentDetails, theme: Theme): string {
	const settled = details.runs.filter((run) => run.status !== "running" && run.status !== "queued").length;
	return theme.fg("accent", `› ${settled}/${details.runs.length} done · ${elapsed(details.startedAt) ?? "0.0s"}`);
}

function taskRow(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme, live: boolean): string {
	let line = `  ${statusMarker(run.status, theme)} ${theme.fg("accent", profileLabel(run.agent))}${theme.fg("dim", ` · ${taskSummary(args, index, run)}`)}`;
	const detail = live ? runningDetail(run) : undefined;
	if (detail) {
		line += theme.fg("dim", ` — ${detail}`);
	} else if (run.status !== "running" && run.status !== "queued") {
		const duration = elapsed(run.startedAt, run.endedAt);
		if (duration) line += theme.fg("dim", ` · ${duration}`);
	}
	return line;
}

function outcomeSummary(details: SubagentDetails): string {
	const completed = details.runs.filter((run) => run.status === "completed").length;
	const failed = details.runs.filter((run) => run.status === "failed").length;
	const aborted = details.runs.filter((run) => run.status === "aborted").length;
	const parts: string[] = [];
	if (completed) parts.push(`${completed} completed`);
	if (failed) parts.push(`${failed} failed`);
	if (aborted) parts.push(`${aborted} aborted`);
	if (parts.length === 0) parts.push(statusSummary(details));
	const duration = elapsed(details.startedAt, details.endedAt);
	if (duration) parts.push(duration);
	if (details.usage.cost) parts.push(`$${details.usage.cost.toFixed(3)}`);
	return parts.join(" · ");
}

function runMetrics(run: SubagentRunDetails): string {
	const items = [run.model];
	if (run.thinking !== "off") items.push(`${run.thinking} thinking`);
	if (run.cwd) items.push(`cwd: ${run.cwd}`);
	const settled = run.status !== "running" && run.status !== "queued";
	if (settled && run.usage.totalTokens) items.push(`${formatTokens(run.usage.totalTokens)} tok`);
	if (run.usage.toolUses) items.push(`${run.usage.toolUses} tool use${run.usage.toolUses === 1 ? "" : "s"}`);
	if (run.usage.turns) items.push(`${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}`);
	if (run.usage.contextTokens) items.push(`ctx: ${formatTokens(run.usage.contextTokens)}`);
	if (run.usage.cost) items.push(`$${run.usage.cost.toFixed(3)}`);
	const duration = elapsed(run.startedAt, run.endedAt);
	if (duration) items.push(duration);
	return items.join(" · ");
}

function activityLine(activity: ToolActivity, run: SubagentRunDetails, theme: Theme): string {
	const summary =
		activity.status === "running" && run.currentActivity
			? truncate(plainLine(run.currentActivity), ACTIVITY_SUMMARY_LIMIT)
			: truncate(plainLine(activity.summary), ACTIVITY_SUMMARY_LIMIT);
	let line =
		activity.status === "failed"
			? `${theme.fg("error", "×")} ${theme.fg("toolOutput", summary)}`
			: activity.status === "running"
				? `${theme.fg("accent", "›")} ${theme.fg("toolOutput", summary)}`
				: `  ${theme.fg("toolOutput", summary)}`;
	if (activity.status === "failed" && activity.resultSummary) {
		line += theme.fg("error", ` · ${truncate(plainLine(activity.resultSummary), ACTIVITY_RESULT_LIMIT)}`);
	}
	if (activity.endedAt !== undefined && activity.endedAt - activity.startedAt >= ACTIVITY_DURATION_MIN_MS) {
		line += theme.fg("dim", ` · ${formatDuration((activity.endedAt - activity.startedAt) / 1_000)}`);
	}
	return line;
}

function runHeader(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): string {
	return `${theme.fg("dim", `── #${index + 1} `)}${statusMarker(run.status, theme)} ${theme.fg("accent", profileLabel(run.agent))}${theme.fg("dim", ` · ${taskSummary(args, index, run)}`)}`;
}

function renderRunningRun(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Text(runHeader(run, index, args, theme), 0, 0));
	container.addChild(new Text(theme.fg("dim", runMetrics(run)), 0, 0));
	const retry = retryText(run);
	if (retry) container.addChild(new Text(theme.fg("accent", retry), 0, 0));
	container.addChild(new Spacer(1));
	const total = Math.max(run.usage.toolUses, run.activities.length);
	const label = total > run.activities.length ? `Activity · last ${run.activities.length} of ${total}` : "Activity";
	container.addChild(new Text(theme.fg("muted", label), 0, 0));
	if (run.activities.length > 0) {
		for (const activity of run.activities) container.addChild(new Text(activityLine(activity, run, theme), 0, 0));
	} else {
		const fallback = retry
			? "Waiting to retry"
			: run.status === "failed" || run.status === "aborted"
				? "No activity recorded"
				: (runningDetail(run) ?? statusWord(run.status));
		container.addChild(new Text(theme.fg("dim", `  ${fallback}`), 0, 0));
	}
	if (run.error) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Error"), 0, 0));
		container.addChild(new Text(theme.fg("error", run.error), 0, 0));
	}
	return container;
}

function renderSettledRun(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Text(runHeader(run, index, args, theme), 0, 0));
	container.addChild(new Text(theme.fg("dim", runMetrics(run)), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Prompt"), 0, 0));
	container.addChild(new Text(theme.fg("toolOutput", taskPrompt(args, index, run)), 0, 0));
	if (run.error) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Error"), 0, 0));
		container.addChild(new Text(theme.fg("error", run.error), 0, 0));
	}
	container.addChild(new Spacer(1));
	const reportLabel = run.status !== "completed" && run.report ? "Report · partial" : "Report";
	container.addChild(new Text(theme.fg("muted", reportLabel), 0, 0));
	if (run.report) {
		container.addChild(
			new Markdown(run.report, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("toolOutput", text),
			}),
		);
	} else {
		container.addChild(new Text(theme.fg("muted", "(No report.)"), 0, 0));
	}
	return container;
}

function fallbackResult(result: AgentToolResult<SubagentDetails>, theme: Theme, isError: boolean): Component {
	const text = result.content.find((part) => part.type === "text");
	const value = text?.type === "text" ? truncate(text.text, FALLBACK_OUTPUT_LIMIT) : "(no output)";
	return new Text(theme.fg(isError ? "error" : "muted", value), 0, 0);
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
	const label = `${count} task${count === 1 ? "" : "s"}`;
	return new Text(
		`${theme.fg("toolTitle", theme.bold("Subagent"))}${theme.fg(count > 0 ? "dim" : "error", ` · ${label}`)}`,
		0,
		0,
	);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	args: SubagentParams,
	isError: boolean,
): Component {
	const details = result.details;
	if (!details || !Array.isArray(details.runs)) return fallbackResult(result, theme, isError);
	if (details.runs.length === 0) return new Text(theme.fg("muted", "Initializing…"), 0, 0);

	if (!options.expanded) {
		const container = new Container();
		const header = options.isPartial
			? progressHeader(details, theme)
			: `${batchMarker(details, theme)} ${theme.fg(isError ? "error" : "muted", outcomeSummary(details))}`;
		container.addChild(new Text(header, 0, 0));
		for (const [index, run] of details.runs.entries()) {
			container.addChild(new Text(taskRow(run, index, args, theme, options.isPartial), 0, 0));
		}
		return container;
	}

	const container = new Container();
	const header = options.isPartial
		? progressHeader(details, theme)
		: `${batchMarker(details, theme)} ${theme.fg(isError ? "error" : "toolTitle", outcomeSummary(details))}`;
	container.addChild(new Text(header, 0, 0));
	for (const [index, run] of details.runs.entries()) {
		container.addChild(new Spacer(1));
		container.addChild(
			options.isPartial ? renderRunningRun(run, index, args, theme) : renderSettledRun(run, index, args, theme),
		);
	}
	return container;
}
