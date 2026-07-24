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

function singleAgentName(args: { agent?: string }): string {
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

function excerpt(text: string, limit: number): string {
	// finalOutput/liveText carry model-facing truncation notices from
	// boundText/tailText; in the transcript an ellipsis is enough.
	const cleaned = text.replace(/\[(?:Output truncated(?:: \d+ bytes omitted\.)?|Earlier output omitted\.)\]/gu, "…");
	return truncate(stripInlineMarkdown(cleaned).replace(/\s+/gu, " ").trim(), limit);
}

function liveTail(run: SubagentRunDetails): string | undefined {
	const lines = run.liveText
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1);
	return last ? excerpt(last, LIVE_TAIL_LIMIT) : undefined;
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

function runLine(run: SubagentRunDetails, theme: Theme, mode: SubagentDetails["mode"]): string {
	let line = runTitle(run, theme, mode);
	const detail =
		run.status === "running"
			? run.currentActivity
			: run.status === "failed" || run.status === "aborted"
				? run.error && excerpt(run.error, RUN_LINE_EXCERPT_LIMIT)
				: run.finalOutput && excerpt(run.finalOutput, RUN_LINE_EXCERPT_LIMIT);
	if (detail) line += theme.fg(run.status === "failed" ? "error" : "dim", ` — ${detail}`);
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
	if (!run) return [theme.fg("muted", "starting")];
	if (run.status === "running" || run.status === "queued") {
		const lines = [
			`${statusMarker(run.status, theme)} ${theme.fg("dim", run.currentActivity ?? (run.status === "queued" ? "queued" : "thinking"))}`,
		];
		const tail = liveTail(run);
		if (tail) lines.push(theme.fg("dim", tail));
		return lines;
	}
	if (run.error) return [theme.fg("error", excerpt(run.error, SINGLE_EXCERPT_LIMIT))];
	if (run.finalOutput) return [theme.fg("toolOutput", excerpt(run.finalOutput, SINGLE_EXCERPT_LIMIT))];
	return [theme.fg("muted", run.status)];
}

function usageText(details: SubagentDetails): string {
	const usage = details.usage;
	const items: string[] = [];
	if (usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (usage.turns) items.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.output) items.push(`↓${formatTokens(usage.output)}`);
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

function renderRunDetails(run: SubagentRunDetails, theme: Theme, mode: SubagentDetails["mode"]): Component {
	const container = new Container();
	let title = runTitle(run, theme, mode);
	if (run.startedAt && run.endedAt) {
		title += theme.fg("dim", ` · ${formatDuration(Math.max(0, (run.endedAt - run.startedAt) / 1000))}`);
	}
	container.addChild(new Text(title, 0, 0));
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
			let text = `${marker} ${theme.fg("toolOutput", activity.summary)}`;
			if (activity.resultSummary) text += ` ${theme.fg("dim", `· ${activity.resultSummary}`)}`;
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
		run.usage.toolUses ? `${run.usage.toolUses} tool uses` : undefined,
		run.usage.turns ? `${run.usage.turns} turns` : undefined,
		run.usage.output ? `↓${formatTokens(run.usage.output)}` : undefined,
		run.usage.cost ? `$${run.usage.cost.toFixed(3)}` : undefined,
	]
		.filter((item): item is string => Boolean(item))
		.join(" · ");
	if (metadata) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", metadata), 0, 0));
	}
	return container;
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold("Subagent "));
	if (args.tasks) {
		text += theme.fg("accent", `parallel · ${args.tasks.length} tasks`);
		for (const task of args.tasks.slice(0, 3)) {
			text += `\n${theme.fg("muted", "  ")}${theme.fg("accent", task.agent ?? "general")}${theme.fg("dim", ` · ${truncate(task.description, 72)}`)}`;
		}
		if (args.tasks.length > 3) text += `\n${theme.fg("muted", `  +${args.tasks.length - 3} more`)}`;
	} else if (args.chain) {
		text += theme.fg("accent", `chain · ${args.chain.length} steps`);
		for (const [index, task] of args.chain.slice(0, 3).entries()) {
			text += `\n${theme.fg("muted", `  ${index + 1}. `)}${theme.fg("accent", task.agent ?? "general")}${theme.fg("dim", ` · ${truncate(task.description, 72)}`)}`;
		}
		if (args.chain.length > 3) text += `\n${theme.fg("muted", `  +${args.chain.length - 3} more`)}`;
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
			lines.push(theme.fg(isError ? "error" : options.isPartial ? "accent" : "muted", statusSummary(details)));
			const shown = selectCollapsedRuns(details.runs, Boolean(options.isPartial));
			for (const run of shown) lines.push(runLine(run, theme, details.mode));
			const hidden = details.runs.length - shown.length;
			if (hidden > 0) lines.push(theme.fg("muted", `+${hidden} more`));
		}
		const usage = usageText(details);
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
		container.addChild(renderRunDetails(run, theme, details.mode));
	});
	const usage = usageText(details);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}
