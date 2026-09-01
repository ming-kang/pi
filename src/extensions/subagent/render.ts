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
import { getMarkdownTheme, type Theme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import { activityCallText, isDisplayableActivity } from "./activity.ts";
import { AGENT_PROFILE_LABELS } from "./agents.ts";
import { COMPACTION_ACTIVITY_ID, DISPLAY_ACTIVITY_LIMIT, type SubagentAgentName } from "./constants.ts";
import type { SubagentParams } from "./schema.ts";
import { getSubagentRetryView } from "./state.ts";
import { plainLine, truncate } from "./text.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentRunStatus, ToolActivity } from "./types.ts";

const RETRY_ERROR_LIMIT = 160;
const FALLBACK_OUTPUT_LIMIT = 4_000;
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

function latestRunningActivity(run: SubagentRunDetails, toolName: string): ToolActivity | undefined {
	for (let index = run.activities.length - 1; index >= 0; index--) {
		const activity = run.activities[index];
		if (activity?.status === "running" && activity.toolName === toolName) return activity;
	}
	return undefined;
}

function formatTotalTokens(value: number): string {
	const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	if (count < 1_000) return String(count);
	const divisor = count < 999_950 ? 1_000 : 1_000_000;
	const suffix = divisor === 1_000 ? "k" : "M";
	const rounded = Math.round((count / divisor) * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
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
		if (packed <= usable) return [joined];
		if (this.cellWidth > usable) {
			return this.segments.map((segment) => truncateToWidth(segment, usable, "..."));
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

function toolCallLabel(count: number): string {
	return `${count} tool call${count === 1 ? "" : "s"}`;
}

function runHeader(run: SubagentRunDetails, index: number, theme: Theme): string {
	const separator = theme.fg("dim", " · ");
	const duration = elapsed(run.startedAt, run.endedAt) ?? "0.0s";
	const metrics = [
		run.model,
		run.thinking,
		`${formatTotalTokens(run.usage.totalTokens)} tok`,
		toolCallLabel(run.usage.toolUses),
		duration,
	].map((metric) => theme.fg("muted", metric));
	return [theme.fg("accent", theme.bold(`#${index + 1} ${profileLabel(run.agent)}`)), ...metrics].join(separator);
}

function sectionTitle(title: string, theme: Theme, color: ThemeColor, suffix?: string): string {
	const heading = theme.fg(color, theme.bold(title));
	return suffix ? `${heading}${theme.fg("dim", ` · ${suffix}`)}` : heading;
}

function activityTitleSuffix(total: number, shown: number): string {
	if (total <= DISPLAY_ACTIVITY_LIMIT && shown >= total) return toolCallLabel(total);
	if (shown > 0) return `last ${shown} of ${total} tool calls`;
	return toolCallLabel(total);
}

function activityLine(activity: ToolActivity, theme: Theme): string {
	// State color stays on the two-column status marker; the call text itself
	// keeps the quiet toolOutput color so a running row does not flash a whole
	// accent-colored command line on every refresh.
	const text = theme.fg("toolOutput", activityCallText(activity));
	if (activity.status === "failed") return `${theme.fg("error", "×")} ${text}`;
	if (activity.status === "running") return `${theme.fg("accent", "›")} ${text}`;
	return `  ${text}`;
}

function addPrompt(
	container: Container,
	run: SubagentRunDetails,
	index: number,
	args: SubagentParams,
	theme: Theme,
): void {
	container.addChild(new Text(sectionTitle("Prompt", theme, "toolTitle"), 0, 0));
	container.addChild(new Text(theme.fg("toolOutput", taskPrompt(args, index, run)), 2, 0));
}

function addActivity(container: Container, run: SubagentRunDetails, theme: Theme): void {
	const toolCalls = run.activities.filter(isDisplayableActivity);
	const shown = toolCalls.slice(-DISPLAY_ACTIVITY_LIMIT);
	const total = Math.max(run.usage.toolUses, toolCalls.length);
	container.addChild(
		new Text(sectionTitle("Activity", theme, "toolTitle", activityTitleSuffix(total, shown.length)), 0, 0),
	);
	if (shown.length === 0) {
		const empty = total === 0 ? "No tool calls yet." : "Activity unavailable.";
		container.addChild(new Text(theme.fg("muted", empty), 2, 0));
		return;
	}
	for (const activity of shown) container.addChild(new SingleLineText(activityLine(activity, theme)));
}

function outcomeColor(status: SubagentRunStatus): ThemeColor {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "aborted") return "warning";
	return "accent";
}

function outcomeReport(run: SubagentRunDetails): string {
	if (typeof run.report === "string") return run.report;
	const legacyOutput = (run as SubagentRunDetails & { finalOutput?: unknown }).finalOutput;
	return typeof legacyOutput === "string" ? legacyOutput : "";
}

function hasOutcome(report: string): boolean {
	return report.trim().length > 0;
}

function addOutcomeMarkdown(container: Container, report: string, theme: Theme): void {
	container.addChild(
		new Markdown(report, 2, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("toolOutput", text),
		}),
	);
}

function addOutcome(container: Container, run: SubagentRunDetails, theme: Theme): void {
	const color = outcomeColor(run.status);
	const report = outcomeReport(run);
	container.addChild(new Text(sectionTitle("Outcome", theme, color), 0, 0));

	if (run.status === "queued" || run.status === "running") {
		container.addChild(new Text(theme.fg("muted", "Still running..."), 2, 0));
		const retry = retryText(run);
		if (retry) {
			container.addChild(new Text(theme.fg("warning", retry), 2, 0));
		} else if (latestRunningActivity(run, COMPACTION_ACTIVITY_ID)) {
			container.addChild(new Text(theme.fg("accent", "Compacting context..."), 2, 0));
		}
		return;
	}

	if (run.status === "completed") {
		if (hasOutcome(report)) addOutcomeMarkdown(container, report, theme);
		else container.addChild(new Text(theme.fg("muted", "No outcome returned."), 2, 0));
		return;
	}

	const verdict = run.status === "failed" ? "Failed" : "Aborted";
	const reason = run.error ? `${verdict}: ${run.error}` : `${verdict}.`;
	container.addChild(new Text(theme.fg(color, reason), 2, 0));
	if (hasOutcome(report)) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Partial outcome:"), 2, 0));
		addOutcomeMarkdown(container, report, theme);
	}
}

function renderRun(run: SubagentRunDetails, index: number, args: SubagentParams, theme: Theme): Component {
	const container = new Container();
	container.addChild(new SingleLineText(runHeader(run, index, theme)));
	container.addChild(new Spacer(1));
	addPrompt(container, run, index, args, theme);
	container.addChild(new Spacer(1));
	addActivity(container, run, theme);
	container.addChild(new Spacer(1));
	addOutcome(container, run, theme);
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
	/** Called by the shell when the transcript row is disposed. */
	dispose?: () => void;
}

type SubagentToolRenderContext = ToolRenderContext<SubagentRenderState, SubagentParams, SubagentDetails>;

/** Pure refresh policy: schedule only while the current view contains changing text. */
export function desiredRefreshInterval(
	runs: readonly SubagentRunDetails[],
	options: { isPartial: boolean; expanded: boolean },
): number | undefined {
	if (!options.isPartial) return undefined;
	if (!options.expanded) {
		return runs.some((run) => run.status === "running") ? SPINNER_INTERVAL_MS : undefined;
	}
	return runs.some((run) => run.status === "running" || run.retry !== undefined)
		? ELAPSED_REFRESH_INTERVAL_MS
		: undefined;
}

function clearLiveRefresh(state: SubagentRenderState): void {
	if (state.refreshTimer !== undefined) clearTimeout(state.refreshTimer);
	state.refreshTimer = undefined;
	state.refreshInterval = undefined;
}

// One one-shot timer per row. A paint with the same cadence keeps the existing
// deadline; expansion, settlement, or loss of dynamic content clears or
// reschedules immediately.
export function scheduleLiveRefresh(context: SubagentToolRenderContext, isPartial: boolean): void {
	const state = context.state;
	state.dispose ??= () => clearLiveRefresh(state);
	const interval = desiredRefreshInterval(context.result?.details?.runs ?? [], {
		isPartial,
		expanded: context.expanded,
	});
	if (interval === undefined) {
		clearLiveRefresh(state);
		return;
	}
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
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
	const title = theme.fg(count > 0 ? "toolTitle" : "error", theme.bold("Subagent"));
	return new Text(title, 0, 0);
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

	for (const [index, run] of details.runs.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		container.addChild(renderRun(run, index, args, theme));
	}
	return container;
}
