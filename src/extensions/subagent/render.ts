import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { statusSummary } from "./runner.ts";
import type { SubagentParams } from "./schema.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentRunStatus } from "./types.ts";

const SINGLE_EXCERPT_LIMIT = 200;
const RUN_LINE_EXCERPT_LIMIT = 64;
const LIVE_TAIL_LIMIT = 100;
const COLLAPSED_RUN_LIMIT = 4;

const ACTIVITY_GROUPS = [
	{ toolName: "read", verb: "read", singular: "file", plural: "files" },
	{ toolName: "grep", verb: "searched", singular: "pattern", plural: "patterns" },
	{ toolName: "find", verb: "searched", singular: "path pattern", plural: "path patterns" },
	{ toolName: "ls", verb: "listed", singular: "directory", plural: "directories" },
	{ toolName: "bash", verb: "ran", singular: "command", plural: "commands" },
	{ toolName: "edit", verb: "edited", singular: "file", plural: "files" },
	{ toolName: "write", verb: "wrote", singular: "file", plural: "files" },
] as const;

function singleAgentName(args: { agent?: string | null }): string {
	return args.agent ?? "general";
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

// Transcript excerpts render inside plain Text components, so markdown
// punctuation would show up literally; strip the common inline syntax.
function stripInlineMarkdown(text: string): string {
	return text
		.replace(/```[a-zA-Z0-9-]*/gu, "")
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/\*\*([^*]+)\*\*/gu, "$1")
		.replace(/__([^_]+)__/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/^#{1,6}\s+/gmu, "");
}

// Markdown tables and horizontal rules turn into symbol soup when
// flattened onto one line; drop those lines before inline stripping.
function stripBlockMarkdown(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("|")) return false;
			return !(trimmed.length >= 3 && /^[-—─═=*_|:\s]+$/u.test(trimmed));
		})
		.join("\n");
}

function excerpt(text: string, limit: number): string {
	// finalOutput/liveText carry model-facing truncation notices from
	// boundText/tailText; in the transcript an ellipsis is enough.
	const cleaned = text.replace(/\[(?:Output truncated(?:: \d+ bytes omitted\.)?|Earlier output omitted\.)\]/gu, "…");
	return truncate(stripInlineMarkdown(stripBlockMarkdown(cleaned)).replace(/\s+/gu, " ").trim(), limit);
}

function liveTail(run: SubagentRunDetails): string | undefined {
	const lines = run.liveText
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1);
	return last ? excerpt(last, LIVE_TAIL_LIMIT) : undefined;
}

// Completed-run excerpts read better cut at a sentence boundary than
// mid-word; fall back to a hard truncate when no boundary lands in the
// second half of the window.
function leadingSentences(text: string, limit: number): string {
	const cleaned = excerpt(text, Number.MAX_SAFE_INTEGER);
	if (cleaned.length <= limit) return cleaned;
	const window = cleaned.slice(0, limit);
	let boundary = -1;
	for (const match of window.matchAll(/[.!?。！？](?=\s|$)/gu)) {
		boundary = (match.index ?? 0) + match[0].length;
	}
	if (boundary >= limit / 2) return window.slice(0, boundary).trimEnd();
	return truncate(window, limit);
}

const VERIFY_COMMAND_PATTERN = /\b(test|lint|typecheck|tsc|vitest|jest|pytest|build|check|fmt|format|compile)\b/iu;
const RETRY_MARKER_PATTERN = /^Retrying\b/u;
const STREAM_MARKERS = new Set(["Thinking…", "Writing response…"]);

// Translates raw tool traffic into what the worker is doing right now, so
// the collapsed card reads as a phase instead of a command line. Modelled
// on tool-type classification; the raw tool summary stays as evidence on
// the next line.
function runIntent(run: SubagentRunDetails): string {
	const current = run.currentActivity;
	if (current && RETRY_MARKER_PATTERN.test(current)) return current;
	const running = [...run.activities].reverse().find((activity) => activity.status === "running");
	if (running) {
		if (running.toolName === "edit" || running.toolName === "write") return "Applying changes";
		if (running.toolName === "bash") {
			return VERIFY_COMMAND_PATTERN.test(running.summary) ? "Verifying changes" : "Running commands";
		}
		return "Exploring code";
	}
	const recent = run.activities.slice(-5);
	if (current && STREAM_MARKERS.has(current)) {
		if (recent.some((activity) => activity.status === "failed")) return "Investigating a failure";
		return current;
	}
	if (recent.some((activity) => activity.status === "failed")) return "Investigating a failure";
	if (recent.some((activity) => activity.toolName === "edit" || activity.toolName === "write"))
		return "Reviewing changes";
	if (recent.length > 0) return "Exploring code";
	return current ?? "Thinking…";
}

// The raw tool summary backs up the intent line; suppress it when it would
// just repeat a stream/retry marker.
function runEvidence(run: SubagentRunDetails): string | undefined {
	const current = run.currentActivity;
	if (!current || STREAM_MARKERS.has(current) || RETRY_MARKER_PATTERN.test(current)) return undefined;
	return current;
}

function liveElapsed(run: SubagentRunDetails): string | undefined {
	if (run.startedAt === undefined) return undefined;
	const end = run.endedAt ?? Date.now();
	return formatDuration(Math.max(0, (end - run.startedAt) / 1000));
}

function statusMarker(status: SubagentRunStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "×");
		case "aborted":
			return theme.fg("warning", "■");
		case "running":
			return theme.fg("accent", "●");
		default:
			return theme.fg("muted", "○");
	}
}

function runTitle(run: SubagentRunDetails, theme: Theme, mode: SubagentDetails["mode"]): string {
	const step = mode === "chain" && run.step ? theme.fg("muted", `${run.step}. `) : "";
	return `${statusMarker(run.status, theme)} ${step}${theme.fg("accent", run.agent)}${theme.fg("dim", ` · ${truncate(run.description, 48)}`)}`;
}

function runProgressText(run: SubagentRunDetails): string {
	const items = [`${run.usage.toolUses} tool use${run.usage.toolUses === 1 ? "" : "s"}`];
	if (run.usage.totalTokens) items.push(`${formatTokens(run.usage.totalTokens)} tokens`);
	return items.join(" · ");
}

function runLine(run: SubagentRunDetails, theme: Theme, mode: SubagentDetails["mode"]): string {
	let line = runTitle(run, theme, mode);
	const detail =
		run.status === "running"
			? runIntent(run)
			: run.status === "failed" || run.status === "aborted"
				? run.error && excerpt(run.error, RUN_LINE_EXCERPT_LIMIT)
				: run.finalOutput && excerpt(run.finalOutput, RUN_LINE_EXCERPT_LIMIT);
	if (detail) line += theme.fg(run.status === "failed" ? "error" : "dim", ` — ${detail}`);
	if (run.status === "running") {
		line += theme.fg("dim", ` · ${runProgressText(run)}`);
		const elapsed = liveElapsed(run);
		if (elapsed) line += theme.fg("dim", ` · ${elapsed}`);
	}
	const settled = run.status !== "running" && run.status !== "queued";
	if (settled && run.startedAt !== undefined && run.endedAt !== undefined) {
		line += theme.fg("dim", ` · ${formatDuration(Math.max(0, (run.endedAt - run.startedAt) / 1000))}`);
	}
	return line;
}

// Keep active work visible while a batch is in flight: completed runs
// may otherwise crowd a still-running task out of the collapsed window.
function selectCollapsedRuns(runs: SubagentRunDetails[], isPartial: boolean): SubagentRunDetails[] {
	if (runs.length <= COLLAPSED_RUN_LIMIT) return runs;
	if (!isPartial) return runs.slice(0, COLLAPSED_RUN_LIMIT);
	const active = runs.filter((run) => run.status === "running" || run.status === "queued");
	const settled = runs.filter((run) => run.status !== "running" && run.status !== "queued");
	return [...active, ...settled].slice(0, COLLAPSED_RUN_LIMIT);
}

function singleCollapsedLines(details: SubagentDetails, theme: Theme): string[] {
	const run = details.runs[0];
	if (!run) return [theme.fg("muted", "Initializing…")];
	if (run.status === "running" || run.status === "queued") {
		const isInitializing =
			run.status === "running" && run.usage.turns === 0 && run.usage.toolUses === 0 && run.liveText.length === 0;
		const intent =
			run.status === "queued"
				? (run.currentActivity ?? "queued")
				: isInitializing
					? "Initializing…"
					: runIntent(run);
		let status = `${statusMarker(run.status, theme)} ${theme.fg("dim", intent)}`;
		if (run.status === "running" && !isInitializing) {
			status += theme.fg("dim", ` · ${runProgressText(run)}`);
			const elapsed = liveElapsed(run);
			if (elapsed) status += theme.fg("dim", ` · ${elapsed}`);
		}
		const lines = [status];
		const evidence = runEvidence(run);
		if (evidence && evidence !== intent) lines.push(theme.fg("dim", excerpt(evidence, LIVE_TAIL_LIMIT)));
		const tail = liveTail(run);
		if (tail) lines.push(theme.fg("dim", tail));
		return lines;
	}
	if (run.error) return [theme.fg("error", excerpt(run.error, SINGLE_EXCERPT_LIMIT))];
	if (run.finalOutput) return [theme.fg("toolOutput", leadingSentences(run.finalOutput, SINGLE_EXCERPT_LIMIT))];
	return [theme.fg("muted", run.status)];
}

function activitySummaryText(details: SubagentDetails): string {
	const toolCounts = new Map<string, number>();
	let activityCount = 0;
	for (const run of details.runs) {
		for (const activity of run.activities) {
			activityCount++;
			toolCounts.set(activity.toolName, (toolCounts.get(activity.toolName) ?? 0) + 1);
		}
	}
	const items: string[] = [];
	let groupedCount = 0;
	for (const group of ACTIVITY_GROUPS) {
		const count = toolCounts.get(group.toolName) ?? 0;
		if (count === 0) continue;
		groupedCount += count;
		items.push(`${group.verb} ${count} ${count === 1 ? group.singular : group.plural}`);
	}
	const otherCount = activityCount - groupedCount;
	if (otherCount > 0) items.push(`used ${otherCount} other tool${otherCount === 1 ? "" : "s"}`);
	if (items.length === 0) return "";
	const earlierCount = Math.max(0, details.usage.toolUses - activityCount);
	if (earlierCount > 0) items.push(`${earlierCount} earlier tool use${earlierCount === 1 ? "" : "s"}`);
	return `${items[0]![0]!.toUpperCase()}${items[0]!.slice(1)}${items
		.slice(1)
		.map((item) => ` · ${item}`)
		.join("")}`;
}

function usageText(details: SubagentDetails, includeToolUses = true): string {
	const usage = details.usage;
	const items: string[] = [];
	if (includeToolUses && usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (usage.turns) items.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.output) items.push(`↓${formatTokens(usage.output)}`);
	if (usage.contextTokens) items.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (usage.cost) items.push(`$${usage.cost.toFixed(3)}`);
	const duration = details.endedAt ? Math.max(0, (details.endedAt - details.startedAt) / 1000) : undefined;
	if (duration !== undefined) items.push(formatDuration(duration));
	return items.join(" · ");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(seconds: number): string {
	if (seconds >= 90) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
	return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

// A single run's title and usage would duplicate the call header and
// the call-level usage line, so `single` drops both and folds the
// duration into the metadata line instead.
function renderRunDetails(
	run: SubagentRunDetails,
	theme: Theme,
	mode: SubagentDetails["mode"],
	single: boolean,
): Component {
	const container = new Container();
	const duration =
		run.startedAt !== undefined && run.endedAt !== undefined
			? formatDuration(Math.max(0, (run.endedAt - run.startedAt) / 1000))
			: undefined;
	if (!single) {
		let title = runTitle(run, theme, mode);
		if (run.status === "running") title += theme.fg("dim", ` · ${runProgressText(run)}`);
		else if (duration) title += theme.fg("dim", ` · ${duration}`);
		container.addChild(new Text(title, 0, 0));
	}
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Text(theme.fg("dim", run.prompt), 0, 0));
	if (run.activities.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Activity"), 0, 0));
		for (const activity of run.activities) {
			const marker =
				activity.status === "succeeded"
					? theme.fg("success", "✓")
					: activity.status === "failed"
						? theme.fg("error", "×")
						: theme.fg("accent", "●");
			let text = `${marker} ${theme.fg("toolOutput", excerpt(activity.summary, 96))}`;
			if (activity.resultSummary) text += ` ${theme.fg("dim", `· ${excerpt(activity.resultSummary, 64)}`)}`;
			container.addChild(new Text(text, 0, 0));
		}
	}
	if (run.error) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", `Error: ${run.error}`), 0, 0));
	}
	if (run.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Response"), 0, 0));
		container.addChild(new Markdown(run.finalOutput, 0, 0, getMarkdownTheme()));
	}
	const metadata = [
		`${run.model} · ${run.thinking}`,
		run.usage.toolUses ? `${run.usage.toolUses} tool use${run.usage.toolUses === 1 ? "" : "s"}` : undefined,
		run.usage.turns ? `${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}` : undefined,
		run.usage.output ? `↓${formatTokens(run.usage.output)}` : undefined,
		run.usage.contextTokens ? `ctx:${formatTokens(run.usage.contextTokens)}` : undefined,
		run.usage.cost ? `$${run.usage.cost.toFixed(3)}` : undefined,
		single ? duration : undefined,
	]
		.filter((item): item is string => Boolean(item))
		.join(" · ");
	if (metadata) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", metadata), 0, 0));
	}
	return container;
}

// The call header stays a single line: run rows in the result area take
// over within the first update and carry richer per-task state, so a
// task list here would render everything twice.
export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("Subagent "));
	const modes = [args.prompt != null && "prompt", args.tasks != null && "tasks", args.chain != null && "chain"].filter(
		(mode): mode is string => Boolean(mode),
	);
	if (modes.length > 1) {
		text += theme.fg("error", `invalid · ${modes.join(" + ")}`);
	} else if (args.tasks) {
		text += theme.fg("accent", `parallel · ${args.tasks.length} tasks`);
	} else if (args.chain) {
		text += theme.fg("accent", `chain · ${args.chain.length} steps`);
	} else {
		text += theme.fg("accent", singleAgentName(args));
		if (args.description) text += theme.fg("dim", ` · ${truncate(args.description, 72)}`);
	}
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): Component {
	const details = result.details;
	if (!details) {
		const text = result.content.find((part) => part.type === "text");
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}
	if (!options.expanded) {
		const lines: string[] = [];
		if (details.mode === "single") {
			lines.push(...singleCollapsedLines(details, theme));
		} else {
			let header = statusSummary(details);
			if (options.isPartial) {
				header += ` · ${formatDuration(Math.max(0, (Date.now() - details.startedAt) / 1000))}`;
			}
			lines.push(theme.fg(isError ? "error" : options.isPartial ? "accent" : "muted", header));
			const shown = selectCollapsedRuns(details.runs, Boolean(options.isPartial));
			for (const run of shown) lines.push(runLine(run, theme, details.mode));
			const hidden = details.runs.length - shown.length;
			if (hidden > 0) lines.push(theme.fg("muted", `+${hidden} more`));
		}
		const activitySummary = activitySummaryText(details);
		if (activitySummary) lines.push(theme.fg("dim", activitySummary));
		const usage = usageText(details, !activitySummary);
		if (usage) lines.push(theme.fg("dim", usage));
		if (!options.isPartial) lines.push(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
		return new Text(lines.join("\n"), 0, 0);
	}
	const container = new Container();
	const single = details.mode === "single" && details.runs.length === 1;
	if (!single) {
		container.addChild(new Text(theme.fg(isError ? "error" : "toolTitle", statusSummary(details)), 0, 0));
	}
	details.runs.forEach((run, index) => {
		if (!single || index > 0) container.addChild(new Spacer(1));
		container.addChild(renderRunDetails(run, theme, details.mode, single));
	});
	if (!single) {
		const usage = usageText(details);
		if (usage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usage), 0, 0));
		}
	}
	return container;
}
