import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "../../core/extensions/types.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { boundText } from "./activity.ts";
import { statusSummary } from "./runner.ts";
import type { SubagentParams } from "./schema.ts";
import type { SubagentDetails, SubagentRunDetails } from "./types.ts";

function singleAgentName(args: SubagentParams): string {
	return args.agent ?? "general";
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function runStatus(run: SubagentRunDetails, theme: Theme): string {
	const marker =
		run.status === "completed"
			? theme.fg("success", "✓")
			: run.status === "failed"
				? theme.fg("error", "×")
				: run.status === "aborted"
					? theme.fg("warning", "■")
					: run.status === "running"
						? theme.fg("accent", "●")
						: theme.fg("muted", "○");
	return `${marker} ${theme.fg("accent", run.agent)}${theme.fg("dim", ` · ${run.description}`)}`;
}

function usageText(details: SubagentDetails): string {
	const usage = details.usage;
	const items: string[] = [];
	if (usage.toolUses) items.push(`${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`);
	if (usage.turns) items.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.output) items.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) items.push(`$${usage.cost.toFixed(3)}`);
	const duration = details.endedAt ? Math.max(0, (details.endedAt - details.startedAt) / 1000) : undefined;
	if (duration !== undefined) items.push(`${duration.toFixed(duration < 10 ? 1 : 0)}s`);
	return items.join(" · ");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function compactRunLine(run: SubagentRunDetails, theme: Theme): string {
	const activity = run.currentActivity ?? run.activities.at(-1)?.summary;
	const response = run.finalOutput ? boundText(run.finalOutput.replace(/\s+/gu, " "), 160) : undefined;
	const error = run.error ? boundText(run.error.replace(/\s+/gu, " "), 160) : undefined;
	return [
		runStatus(run, theme),
		activity && theme.fg("dim", activity),
		response && theme.fg("toolOutput", response),
		error && theme.fg("error", error),
	]
		.filter((item): item is string => Boolean(item))
		.join("\n");
}

function renderRunDetails(run: SubagentRunDetails, theme: Theme): Component {
	const container = new Container();
	container.addChild(new Text(runStatus(run, theme), 0, 0));
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
		const lines = [theme.fg(isError ? "error" : "muted", statusSummary(details))];
		for (const run of details.runs.slice(0, details.mode === "single" ? 1 : 3)) {
			lines.push(compactRunLine(run, theme));
		}
		if (details.runs.length > 3) lines.push(theme.fg("muted", `+${details.runs.length - 3} more tasks`));
		const usage = usageText(details);
		if (usage) lines.push(theme.fg("dim", usage));
		if (!options.isPartial) lines.push(theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`));
		return new Text(lines.join("\n"), 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(theme.fg(isError ? "error" : "toolTitle", statusSummary(details)), 0, 0));
	for (const run of details.runs) {
		container.addChild(new Spacer(1));
		container.addChild(renderRunDetails(run, theme));
	}
	const usage = usageText(details);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}
