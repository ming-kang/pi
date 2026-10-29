import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, startToolTimer, toolTimerText } from "../../core/tools/render-utils.ts";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { activityGlyph, clipText, formatActivityDuration } from "./activity.ts";
import type { AgentActivity, AgentToolDetails } from "./types.ts";

const COLLAPSED_ACTIVITIES = 3;
const REPORT_PREVIEW_LINES = 3;

type AgentRenderer = Pick<ToolDefinition<any, AgentToolDetails>, "renderCall" | "renderResult">;

function activityColor(status: AgentActivity["status"]): "warning" | "success" | "error" | "muted" {
	switch (status) {
		case "running":
			return "warning";
		case "ok":
			return "success";
		case "error":
			return "error";
		case "cancelled":
			return "muted";
	}
}

function renderActivity(activity: AgentActivity, theme: Theme, expanded: boolean): string {
	const args = expanded ? activity.args : clipText(activity.args, 100);
	const duration = formatActivityDuration(activity.durationMs);
	let line = `${theme.fg(activityColor(activity.status), activityGlyph(activity.status))} ${theme.fg("toolTitle", activity.name)}`;
	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (expanded && activity.error) line += `\n    ${theme.fg("error", activity.error.replaceAll("\n", "\n    "))}`;
	return line;
}

function detailsOf(result: AgentToolResult<AgentToolDetails>): AgentToolDetails | undefined {
	const details = result.details;
	return details?.version === 1 && Array.isArray(details.activities) ? details : undefined;
}

export const agentRenderers: AgentRenderer = {
	renderCall(args, theme, context) {
		startToolTimer(context);
		const input = args as { description?: unknown; prompt?: unknown };
		const title =
			typeof input.description === "string" && input.description.trim()
				? input.description
				: typeof input.prompt === "string"
					? input.prompt
					: "Delegated task";
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		component.addChild(
			new Text(
				`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("muted", clipText(title.replace(/\s+/gu, " ").trim(), 160))}`,
				0,
				0,
			),
		);
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const details = detailsOf(result);
		const activities = details?.activities ?? [];
		const running = options.isPartial || details?.status === "running";
		const background = details?.status === "background";
		if (running || background) {
			if (activities.length) {
				const shown = options.expanded ? activities : activities.slice(-COLLAPSED_ACTIVITIES);
				const lines = shown.map((activity) => renderActivity(activity, theme, options.expanded));
				if (shown.length < activities.length)
					lines.unshift(theme.fg("dim", `… ${activities.length - shown.length} earlier activities`));
				component.addChild(new Spacer(1));
				component.addChild(new Text(lines.join("\n"), 0, 0));
			} else {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("muted", "Starting Agent…"), 0, 0));
			}
			if (background) {
				component.addChild(new Text(theme.fg("dim", "Running in background · /tasks to inspect"), 0, 0));
			}
		} else {
			const report = replaceTabs(getTextOutput(result, context.showImages).trim()) || "No report returned.";
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Markdown(report, 0, 0, getMarkdownTheme()));
			} else {
				const styled = report
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: REPORT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) => theme.fg("dim", `… ${hidden} more report lines`),
					}),
				);
			}
		}
		if (!background) {
			const timer = toolTimerText(context, options.isPartial);
			if (timer) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(theme.fg("muted", timer), 0, 0));
			}
		}
		return component;
	},
};
