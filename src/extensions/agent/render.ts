import { Container, TruncatedText } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition, ToolRenderContext } from "../../core/extensions/types.ts";
import { getTextOutput, startToolTimer, toolTimerText } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { activityGlyph, activityTarget, clipText, formatActivityDuration } from "./activity.ts";
import type { AgentActivity, AgentToolDetails } from "./types.ts";

const EXPANDED_ACTIVITIES = 5;

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

function targetOf(activity: AgentActivity): string {
	if (activity.target) return activity.target;
	try {
		return activityTarget(activity.name, JSON.parse(activity.args));
	} catch {
		return activity.args;
	}
}

function renderActivity(activity: AgentActivity, theme: Theme): string {
	const target = targetOf(activity);
	const duration = formatActivityDuration(activity.durationMs);
	return [
		`${theme.fg(activityColor(activity.status), activityGlyph(activity.status))} ${theme.fg("toolTitle", activity.name)}${target ? theme.fg("muted", ` ${target}`) : ""}`,
		...(duration ? [theme.fg("dim", duration)] : []),
	].join(theme.fg("dim", " · "));
}

function detailsOf(result: AgentToolResult<AgentToolDetails> | undefined): AgentToolDetails | undefined {
	const details = result?.details;
	return details?.version === 1 && Array.isArray(details.activities) ? details : undefined;
}

function singleLine(text: string, bytes = 120): string {
	return clipText(text.replace(/\s+/gu, " ").trim(), bytes);
}

function errorOf(result: AgentToolResult<AgentToolDetails> | undefined, details: AgentToolDetails | undefined): string {
	if (details?.error) return singleLine(details.error);
	const output = result ? getTextOutput(result, false).trim() : "";
	const marker = output.lastIndexOf("Error:");
	return singleLine(marker >= 0 ? output.slice(marker + 6) : output.split("\n")[0] || "Failed");
}

function statusText(
	context: ToolRenderContext<any, any, AgentToolDetails>,
	details: AgentToolDetails | undefined,
): string {
	const status = details?.status;
	if (status === "background") return "Background · /tasks";
	const timer = toolTimerText(context, context.isPartial);
	const duration = timer?.replace(/^(?:Took|Elapsed) /, "");
	const tasks = details?.taskId ? "/tasks" : undefined;
	if (context.isPartial || status === "running") {
		const latest = details?.activities.at(-1);
		const activity = latest ? `${latest.name}${targetOf(latest) ? ` ${targetOf(latest)}` : ""}` : "Starting…";
		return [context.expanded ? undefined : activity, duration].filter(Boolean).join(" · ");
	}
	if (status === "cancelled") return ["Cancelled", duration, tasks].filter(Boolean).join(" · ");
	if (status === "failed" || status === "timeout" || context.isError)
		return [errorOf(context.result, details), duration, tasks].filter(Boolean).join(" · ");
	return [duration, tasks].filter(Boolean).join(" · ");
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
		const status = statusText(context, detailsOf(context.result));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		component.addChild(
			new TruncatedText(
				`${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("muted", singleLine(title, 160))}${status ? theme.fg("dim", ` · ${status}`) : ""}`,
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
		if ((!options.isPartial && details?.status !== "running") || !options.expanded) return component;
		for (const activity of (details?.activities ?? []).slice(-EXPANDED_ACTIVITIES))
			component.addChild(new TruncatedText(renderActivity(activity, theme), 0, 0));
		return component;
	},
};
