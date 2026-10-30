import { type Component, Container, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolDefinition, ToolRenderContext } from "../../core/extensions/types.ts";
import { getTextOutput, startToolTimer, toolTimerText } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { activityGlyph, clipText, formatActivityDuration, targetOf } from "./activity.ts";
import type { AgentActivity, AgentToolDetails } from "./types.ts";

const EXPANDED_ACTIVITIES = 5;

type AgentRenderer = Required<Pick<ToolDefinition<any, AgentToolDetails>, "renderCall" | "renderResult">>;

interface StatusParts {
	diagnostic?: string;
	duration?: string;
	tasks?: string;
}

class AgentCallComponent implements Component {
	private title = "";
	private parts: StatusParts = {};
	private theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	update(theme: Theme, title: string, parts: StatusParts): void {
		this.theme = theme;
		this.title = singleLine(title, 160);
		this.parts = parts;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const heading = this.theme.fg("toolTitle", this.theme.bold("Agent"));
		const available = width - visibleWidth(heading) - 1;
		if (available <= 0) return [truncateToWidth(heading, width, "")];

		// Tasks access and time are fixed; diagnostics take precedence over the task label.
		const { diagnostic, duration, tasks } = this.parts;
		const fullSuffix = [duration, tasks].filter(Boolean).join(" · ");
		const suffix = truncateToWidth(
			visibleWidth(fullSuffix) <= available ? fullSuffix : (tasks ?? duration ?? ""),
			available,
			"…",
		);
		const contentWidth = Math.max(0, available - visibleWidth(suffix) - (suffix ? 3 : 0));
		const shownDiagnostic = truncateToWidth(diagnostic ?? "", contentWidth, "…");
		const titleWidth = Math.max(0, contentWidth - visibleWidth(shownDiagnostic) - (shownDiagnostic ? 3 : 0));
		const title = truncateToWidth(this.title, titleWidth, "…");
		const parts = [
			title ? this.theme.fg("muted", title) : undefined,
			shownDiagnostic ? this.theme.fg("dim", shownDiagnostic) : undefined,
			suffix ? this.theme.fg("dim", suffix) : undefined,
		].filter(Boolean);
		return [heading + (parts.length ? ` ${parts.join(this.theme.fg("dim", " · "))}` : "")];
	}

	invalidate(): void {}
}

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
	return details?.version === 2 && typeof details.state === "string" ? details : undefined;
}

function singleLine(text: string, bytes = 120): string {
	return clipText(text.replace(/\s+/gu, " ").trim(), bytes);
}

function errorOf(result: AgentToolResult<AgentToolDetails> | undefined, details: AgentToolDetails | undefined): string {
	if (details && "error" in details && details.error) return singleLine(details.error, 240);
	const output = result ? getTextOutput(result, false).trim() : "";
	const marker = output.lastIndexOf("Error:");
	return singleLine(marker >= 0 ? output.slice(marker + 6) : output.split("\n")[0] || "Failed", 240);
}

function statusParts(
	context: ToolRenderContext<any, any, AgentToolDetails>,
	details: AgentToolDetails | undefined,
): StatusParts {
	const status = details?.state;
	if (status === "background") {
		toolTimerText(context, false);
		return { diagnostic: "Background", tasks: "/tasks" };
	}
	const timer = toolTimerText(context, context.isPartial);
	const duration = timer?.replace(/^(?:Took|Elapsed) /, "");
	const tasks = details?.taskId ? "/tasks" : undefined;
	if (context.isPartial || status === "running") {
		const latest = details?.state === "running" ? details.activities.at(-1) : undefined;
		const activity = latest ? `${latest.name}${targetOf(latest) ? ` ${targetOf(latest)}` : ""}` : "Starting…";
		return { diagnostic: context.expanded ? undefined : activity, duration };
	}
	if (status === "cancelled") return { diagnostic: "Cancelled", duration, tasks };
	if (status === "failed" || status === "timeout" || context.isError)
		return { diagnostic: errorOf(context.result, details), duration, tasks };
	return { duration, tasks };
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
		const parts = statusParts(context, detailsOf(context.result));
		const component =
			context.lastComponent instanceof AgentCallComponent ? context.lastComponent : new AgentCallComponent(theme);
		component.update(theme, title, parts);
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const details = detailsOf(result);
		// Only live progress carries activities; settled rows stay one line.
		if (details?.state !== "running" || !options.expanded) return component;
		for (const activity of details.activities.slice(-EXPANDED_ACTIVITIES))
			component.addChild(new TruncatedText(renderActivity(activity, theme), 0, 0));
		return component;
	},
};
