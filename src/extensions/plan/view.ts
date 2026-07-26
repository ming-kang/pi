/**
 * plan/view.ts — approval-dialog context and exit_plan tool rendering.
 *
 * `exit_plan` carries the whole plan as a parameter, and the default renderer
 * echoes parameters verbatim: the row would repeat, escaped onto one line, the
 * markdown the model just printed as response text. Collapsed rows therefore
 * carry the title only, and the plan body is available on expand.
 *
 * The result text is written for the model (it restates tool-state precedence
 * rules), so the result row renders from `details` instead.
 */
import type { AgentToolResult, ExtensionContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ExitPlanDecision, ExitPlanDetails } from "./schema.ts";

/** Collapse the home prefix so a plan path stays on one line. */
export function shortenPlanPath(path: string): string {
	const rawHome = process.env.USERPROFILE || process.env.HOME || "";
	const home = rawHome.replace(/[\\/]+$/, "");
	if (!home) return path;
	const normalize = (value: string) => value.replace(/\\/g, "/").toLowerCase();
	if (!normalize(path).startsWith(`${normalize(home)}/`)) return path;
	return `~${path.slice(home.length).replace(/\\/g, "/")}`;
}

/**
 * Context pressure is the fact the compact-or-not decision turns on, so the
 * dialog states it instead of making the user leave and check the footer.
 */
export function formatApprovalSubtitle(ctx: ExtensionContext): string | undefined {
	const percent = ctx.getContextUsage()?.percent;
	if (percent == null) return undefined;
	return `Context now ${percent.toFixed(0)}% full`;
}

// ---- tool call rendering ----------------------------------------------------
// Args arrive off the wire and stream in, so every field is read defensively.

type ExitPlanCallArgs = { title?: unknown; plan?: unknown; revises?: unknown };

function callText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Title-only headline when collapsed; plan body and revision target on expand. */
export function formatExitPlanCall(args: ExitPlanCallArgs | undefined, theme: Theme, expanded: boolean): string {
	const title = callText(args?.title);
	const headline = [
		theme.fg("toolTitle", theme.bold("exit_plan")),
		title ? theme.fg("text", title) : theme.fg("dim", "…"),
	].join(" ");
	if (!expanded) return headline;

	const lines = [headline];
	const revises = callText(args?.revises);
	if (revises) lines.push(theme.fg("dim", `revises ${revises}`));
	const plan = callText(args?.plan);
	if (plan) {
		lines.push("");
		for (const line of plan.split("\n")) lines.push(theme.fg("dim", line));
	}
	return lines.join("\n");
}

// ---- tool result rendering --------------------------------------------------

const DECISION_SUMMARY: Record<ExitPlanDecision, string> = {
	execute: "Executing with full context",
	compactAndExecute: "Compacting context, then executing",
	keepPlanning: "Still planning",
	cancelled: "No approval was pending",
};

function resultText(result: AgentToolResult<ExitPlanDetails>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * What the user needs to know: where the plan landed and what happens next.
 * Falls back to the model-facing text when details are missing — a thrown
 * approval (interrupt) has no details to render from.
 */
export function formatExitPlanResult(result: AgentToolResult<ExitPlanDetails>, theme: Theme): string {
	const details = result.details;
	if (!details) return theme.fg("dim", resultText(result));

	const lines: string[] = [];
	if (details.planPath) lines.push(theme.fg("success", `Saved to ${shortenPlanPath(details.planPath)}`));
	lines.push(theme.fg("dim", DECISION_SUMMARY[details.decision]));
	return lines.join("\n");
}
