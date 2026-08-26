import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { AGENT_PROFILE_LABELS } from "./agents.ts";
import { COMPACTION_ACTIVITY_ID, type SubagentAgentName } from "./constants.ts";
import type { SubagentParams } from "./schema.ts";
import { getSubagentRetryView } from "./state.ts";
import { plainLine, truncate } from "./text.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentRunStatus, ToolActivity } from "./types.ts";

const ACTIVITY_RESULT_LIMIT = 96;
const RETRY_ERROR_LIMIT = 160;
const FALLBACK_OUTPUT_LIMIT = 4_000;
const ACTIVITY_DURATION_MIN_MS = 10_000;
const OUTPUT_TRUNCATION_NOTICE_PATTERN = /\s*\[Output truncated(?:: \d+ bytes omitted)?\.\]\s*$/u;

// A breathing dot-to-star bloom: the sequence plays forward to full bloom
// and back, holding each extreme for two ticks. The mid frame uses ✼ rather
// than the more common ✳ because U+2733 carries the Unicode Emoji property
// and some terminals render it as a double-width color emoji.
const SPINNER_BLOOM = ["·", "✢", "✼", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...SPINNER_BLOOM, ...[...SPINNER_BLOOM].reverse()];
const SPINNER_INTERVAL_MS = 120;
const ELAPSED_REFRESH_INTERVAL_MS = 1_000;
const FLOW_SEPARATOR = " · ";
const FLOW_SEPARATOR_WIDTH = 3;

/** Width-aware single-line text for compact rows and section headers. */
class SingleLineText implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.text, Math.max(1, width), "...")];
	}

	invalidate(): void {}
}

function taskPrompt(args: SubagentParams, index: number, run: SubagentRunDetails): string {
	// Tool calls restored from before the tasks-array shape carry a legacy
	// args object without `tasks`; those sections fall back to the description.
	const tasks = (args as Partial<SubagentParams>).tasks;
	return tasks?.[index]?.prompt ?? run.description;
}

function profileLabel(agent: string): string {
	return AGENT_PROFILE_LABELS[agent as SubagentAgentName] ?? agent;
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
	if (status === "running") return "Thinking...";
	return "Queued";
}

function displayLine(text: string): string {
	return plainLine(text).replace(OUTPUT_TRUNCATION_NOTICE_PATTERN, "...").trim();
}

function retryText(run: SubagentRunDetails): string | undefined {
	const retry = getSubagentRetryView(run);
	if (!retry) return undefined;
	const state =
		retry.remainingSeconds > 0
			? `Retrying (${retry.attempt}/${retry.maxAttempts}) in ${retry.remainingSeconds}s`
			: `Retrying (${retry.attempt}/${retry.maxAttempts}) now...`;
	const error = truncate(displayLine(retry.error), RETRY_ERROR_LIMIT);
	return error ? `${state} · ${error}` : state;
}

function replaceToolPrefix(text: string, toolName: string, label: string, emptyLabel = label): string {
	if (text === toolName) return emptyLabel;
	if (text.startsWith(`${toolName} `)) return `${label}${text.slice(toolName.length)}`;
	return text;
}

function activitySummary(activity: ToolActivity): string {
	const summary = displayLine(activity.summary);
	if (activity.toolName === COMPACTION_ACTIVITY_ID) {
		return activity.status === "running" ? "Compacting..." : summary;
	}
	if (activity.toolName === "bash") return summary === "bash" ? "Run" : summary;
	if (activity.toolName === "read") return replaceToolPrefix(summary, "read", "Read");
	if (activity.toolName === "grep") return replaceToolPrefix(summary, "grep", "Search");
	if (activity.toolName === "find") return replaceToolPrefix(summary, "find", "Find");
	if (activity.toolName === "ls") return replaceToolPrefix(summary, "ls", "List", "List .");
	if (activity.toolName === "edit") return replaceToolPrefix(summary, "edit", "Edit");
	if (activity.toolName === "write") return replaceToolPrefix(summary, "write", "Write");
	return summary || activity.toolName;
}

function latestRunningActivity(run: SubagentRunDetails, toolName?: string): ToolActivity | undefined {
	for (let index = run.activities.length - 1; index >= 0; index--) {
		const activity = run.activities[index];
		if (activity?.status === "running" && (toolName === undefined || activity.toolName === toolName)) return activity;
	}
	return undefined;
}

function fallbackCurrentActivity(run: SubagentRunDetails): string | undefined {
	if (!run.currentActivity) return undefined;
	const current = displayLine(run.currentActivity);
	if (/^Compacting(?: context)?(?:…|\.\.\.)?$/u.test(current)) return "Compacting...";
	return current;
}

function runStateText(run: SubagentRunDetails): string {
	if (run.status === "completed" || run.status === "failed" || run.status === "aborted") {
		const duration = elapsed(run.startedAt, run.endedAt);
		return duration ? `${statusWord(run.status)} · ${duration}` : statusWord(run.status);
	}

	const retry = retryText(run);
	if (retry) return retry;
	if (run.status === "queued") return "Queued";

	const compaction = latestRunningActivity(run, COMPACTION_ACTIVITY_ID);
	if (compaction) return "Compacting...";
	const activity = latestRunningActivity(run);
	if (activity) return activitySummary(activity);
	const current = fallbackCurrentActivity(run);
	if (current) return current;
	if (run.status === "running" && run.usage.turns === 0 && run.usage.toolUses === 0) return "Starting...";
	return statusWord(run.status);
}

function spinnerGlyph(now: number): string {
	const frame = Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0] ?? "";
}

// All spinner and status glyphs are single-width characters; this constant
// documents the expectation and guards against accidental double-width
// substitutions causing layout flicker in the collapsed flow.
const MARKER_WIDTH = 1;

/** One collapsed cell: status glyph, ordinal, and profile label only. */
function flowSegment(run: SubagentRunDetails, index: number, theme: Theme, now: number): string {
	let marker: string;
	if (run.status === "running") {
		const glyph = spinnerGlyph(now);
		// Pad to MARKER_WIDTH so cellWidth stays stable across frames even if
		// a glyph measures wider on some terminal/font combinations.
		const pad = Math.max(0, MARKER_WIDTH - visibleWidth(glyph));
		marker = theme.fg("accent", glyph) + (pad > 0 ? " ".repeat(pad) : "");
	} else {
		marker = statusMarker(run.status, theme);
	}
	return `${marker} ${theme.fg("dim", `#${index + 1}`)} ${theme.fg("accent", profileLabel(run.agent))}`;
}

/** Collapsed batch flow: one cell per run, wrapped at cell boundaries with
 * uniform cell widths so continuation rows keep their columns aligned. */
class CollapsedFlow implements Component {
	private readonly segments: string[];
	private readonly cellWidth: number;

	constructor(segments: string[]) {
		this.segments = segments;
		this.cellWidth = segments.reduce((max, segment) => Math.max(max, visibleWidth(segment)), 1);
	}

	render(width: number): string[] {
		const usable = Math.max(1, width);
		const joined = this.segments.join(FLOW_SEPARATOR);
		const packed = visibleWidth(joined);
		if (this.cellWidth > usable || packed <= usable) {
			return [packed <= usable ? joined : truncateToWidth(joined, usable, "...")];
		}
		const columnCount = Math.max(
			1,
			Math.floor((usable + FLOW_SEPARATOR_WIDTH) / (this.cellWidth + FLOW_SEPARATOR_WIDTH)),
		);
		const lines: string[] = [];
		for (let start = 0; start < this.segments.length; start += columnCount) {
			const row = this.segments.slice(start, start + columnCount);
			lines.push(
				row
					.map((segment, index) => {
						if (index === row.length - 1) return segment;
						const padding = Math.max(0, this.cellWidth - visibleWidth(segment));
						return `${segment}${padding > 0 ? " ".repeat(padding) : ""}${FLOW_SEPARATOR}`;
					})
					.join(""),
			);
		}
		return lines;
	}

	invalidate(): void {}
}

function runHeader(run: SubagentRunDetails, index: number, theme: Theme): string {
	const metrics = [run.model];
	if (run.thinking !== "off") metrics.push(run.thinking);
	if (run.cwd) metrics.push(`cwd: ${run.cwd}`);
	if (run.usage.toolUses) metrics.push(`${run.usage.toolUses} tool use${run.usage.toolUses === 1 ? "" : "s"}`);
	if (run.usage.turns) metrics.push(`${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}`);
	const duration = elapsed(run.startedAt, run.endedAt);
	if (duration) metrics.push(duration);
	return `${theme.fg("dim", `── #${index + 1} `)}${theme.fg("accent", profileLabel(run.agent))}${theme.fg("dim", ` · ${metrics.join(" · ")}`)}`;
}

function activityLine(activity: ToolActivity, theme: Theme): string {
	const summary = activitySummary(activity);
	let line =
		activity.status === "failed"
			? `${theme.fg("error", "×")} ${theme.fg("toolOutput", summary)}`
			: activity.status === "running"
				? `${theme.fg("accent", "›")} ${theme.fg("toolOutput", summary)}`
				: `  ${theme.fg("toolOutput", summary)}`;
	if (activity.status === "failed" && activity.resultSummary) {
		line += theme.fg("error", ` · ${truncate(displayLine(activity.resultSummary), ACTIVITY_RESULT_LIMIT)}`);
	}
	if (activity.endedAt !== undefined && activity.endedAt - activity.startedAt >= ACTIVITY_DURATION_MIN_MS) {
		line += theme.fg("dim", ` · ${formatDuration((activity.endedAt - activity.startedAt) / 1_000)}`);
	}
	return line;
}

function addPrompt(
	container: Container,
	run: SubagentRunDetails,
	index: number,
	args: SubagentParams,
	theme: Theme,
): void {
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Prompt"), 0, 0));
	container.addChild(new Text(theme.fg("toolOutput", taskPrompt(args, index, run)), 0, 0));
}

function renderRunningRun(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): Component {
	const container = new Container();
	container.addChild(new SingleLineText(runHeader(run, index, theme)));
	addPrompt(container, run, index, args, theme);
	container.addChild(new Spacer(1));
	const total = Math.max(run.usage.toolUses, run.activities.length);
	const label = total > run.activities.length ? `Activity · last ${run.activities.length} of ${total}` : "Activity";
	container.addChild(new Text(theme.fg("muted", label), 0, 0));

	const retry = retryText(run);
	if (retry) {
		container.addChild(new SingleLineText(`${statusMarker(run.status, theme)} ${theme.fg("toolOutput", retry)}`));
	}
	for (const activity of run.activities) container.addChild(new SingleLineText(activityLine(activity, theme)));
	if (!retry && run.activities.length === 0) {
		container.addChild(new SingleLineText(theme.fg("dim", `  ${runStateText(run)}`)));
	}
	return container;
}

function renderSettledRun(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): Component {
	const container = new Container();
	container.addChild(new SingleLineText(runHeader(run, index, theme)));
	addPrompt(container, run, index, args, theme);
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

/** Per-result live-refresh state owned by the shell's render context. */
export interface SubagentRenderState {
	refreshTimer?: ReturnType<typeof setTimeout>;
	/** Cadence the current timer was created with, used to detect changes. */
	refreshInterval?: number;
}

type SubagentToolRenderContext = ToolRenderContext<SubagentRenderState, SubagentParams, SubagentDetails>;

// Only genuinely running runs justify spinner-cadence repaints; queued runs
// show a static marker and pick the animation back up via runner updates.
function hasRunningRuns(runs: SubagentRunDetails[]): boolean {
	return runs.some((run) => run.status === "running");
}

// Animate a collapsed flow at the spinner cadence while runs are active;
// otherwise re-render timing and retry text once per second. The first
// settled render clears the timer, and a cadence change (expand/collapse or
// the last run finishing) reschedules immediately instead of waiting out
// the previous interval.
export function scheduleLiveRefresh(context: SubagentToolRenderContext, isPartial: boolean): void {
	const state = context.state;
	if (isPartial) {
		const details = context.result?.details;
		const interval =
			!context.expanded && hasRunningRuns(details?.runs ?? []) ? SPINNER_INTERVAL_MS : ELAPSED_REFRESH_INTERVAL_MS;
		if (state.refreshTimer !== undefined) {
			// Keep a matching timer so unrelated re-renders cannot postpone the
			// next tick; only reschedule when the desired cadence changes.
			if (state.refreshInterval === interval) return;
			clearTimeout(state.refreshTimer);
		}
		state.refreshInterval = interval;
		state.refreshTimer = setTimeout(() => {
			state.refreshTimer = undefined;
			state.refreshInterval = undefined;
			context.invalidate();
		}, interval);
		state.refreshTimer.unref?.();
		return;
	}
	if (state.refreshTimer !== undefined) {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = undefined;
		state.refreshInterval = undefined;
	}
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
	const title = theme.fg(count > 0 ? "toolTitle" : "error", theme.bold("Subagent"));
	return new Text(title, 0, 0);
}

/** Batch-level timing and cost live only in the expanded view. */
function batchSummaryLine(details: SubagentDetails, theme: Theme, isPartial: boolean): string {
	const parts: string[] = [];
	const duration = elapsed(details.startedAt, details.endedAt);
	if (duration) parts.push(duration);
	const cost = details.usage?.cost;
	if (!isPartial && typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(3)}`);
	const tasks = `${details.runs.length} task${details.runs.length === 1 ? "" : "s"}`;
	return `${theme.fg("dim", `── Batch · ${tasks}`)}${parts.length > 0 ? `${theme.fg("dim", ` · ${parts.join(" · ")}`)}` : ""}`;
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
	if (details.runs.length === 0) return new Text(theme.fg("muted", "Starting..."), 0, 0);

	const container = new Container();
	if (!options.expanded) {
		const now = Date.now();
		container.addChild(new CollapsedFlow(details.runs.map((run, index) => flowSegment(run, index, theme, now))));
		return container;
	}

	container.addChild(new SingleLineText(batchSummaryLine(details, theme, options.isPartial)));
	container.addChild(new Spacer(1));
	for (const [index, run] of details.runs.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const settled = run.status === "completed" || run.status === "failed" || run.status === "aborted";
		container.addChild(
			settled ? renderSettledRun(run, index, args, theme) : renderRunningRun(run, index, args, theme),
		);
	}
	return container;
}
