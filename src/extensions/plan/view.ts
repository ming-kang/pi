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
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionContext } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ExitPlanDecision, ExitPlanDetails, PlanKickoffDetails } from "./schema.ts";

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
function formatTokenCount(tokenCount: number): string {
	if (tokenCount < 1000) return `${tokenCount}`;
	if (tokenCount < 10_000) return `${(tokenCount / 1000).toFixed(1)}k`;
	if (tokenCount < 1_000_000) return `${Math.round(tokenCount / 1000)}k`;
	if (tokenCount < 10_000_000) return `${(tokenCount / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokenCount / 1_000_000)}M`;
}

export function formatApprovalSubtitle(ctx: ExtensionContext): string | undefined {
	const usage = ctx.getContextUsage();
	if (usage?.percent == null) return undefined;
	const window = usage.contextWindow > 0 ? ` of ${formatTokenCount(usage.contextWindow)}` : "";
	return `Context ${usage.percent.toFixed(1)}%${window}`;
}

// ---- kickoff message rendering ----------------------------------------------

/**
 * The kickoff message body repeats the whole plan for the LLM, so the default
 * renderer would flood the chat with markdown the user already approved.
 * Collapsed: a two-line card (title + saved path with the expand hint).
 * Expanded: the complete kickoff markdown, styled like the exit_plan body.
 */
export function renderPlanKickoffMessage(
	message: CustomMessage<PlanKickoffDetails>,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const details = (message.details ?? {}) as Partial<PlanKickoffDetails>;
	const title = typeof details.title === "string" && details.title.trim() ? details.title.trim() : "plan";
	const planPath = typeof details.planPath === "string" ? details.planPath.trim() : "";

	const container = new Container();
	container.addChild(
		new Text(
			[theme.fg("toolTitle", theme.bold("plan")), theme.fg("text", `Executing "${title}"`)].join(" "),
			options.outputPad,
			0,
		),
	);
	const pathText = planPath ? `${shortenPlanPath(planPath)} ` : "";
	const secondLine = options.expanded
		? planPath
			? theme.fg("dim", shortenPlanPath(planPath))
			: undefined
		: theme.fg("dim", `${pathText}(${keyText("app.tools.expand")} to expand)`);
	if (secondLine) container.addChild(new Text(secondLine, options.outputPad, 0));
	if (!options.expanded) return container;

	const body =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	if (body.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Markdown(body, options.outputPad, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("toolOutput", text),
			}),
		);
	}
	return container;
}

// ---- tool call rendering ----------------------------------------------------
// Args arrive off the wire and stream in, so every field is read defensively.

type ExitPlanCallArgs = { title?: unknown; plan?: unknown; revises?: unknown };

function callText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Title-only headline when collapsed; Markdown plan body and revision target on expand. */
export function renderExitPlanCall(args: ExitPlanCallArgs | undefined, theme: Theme, expanded: boolean): Component {
	const title = callText(args?.title);
	const headline = [
		theme.fg("toolTitle", theme.bold("exit_plan")),
		title ? theme.fg("text", title) : theme.fg("dim", "…"),
	].join(" ");
	if (!expanded) return new Text(headline, 0, 0);

	const container = new Container();
	container.addChild(new Text(headline, 0, 0));
	const revises = callText(args?.revises);
	if (revises) container.addChild(new Text(theme.fg("dim", `revises ${revises}`), 0, 0));
	const plan = callText(args?.plan);
	if (plan) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Markdown(plan, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("toolOutput", text),
			}),
		);
	}
	return container;
}

// ---- tool result rendering --------------------------------------------------

const DECISION_SUMMARY: Record<ExitPlanDecision, string> = {
	execute: "Executing with full context",
	compactAndExecute: "Compacting context, then executing",
	keepPlanning: "Still planning",
	cancelled: "No approval was pending",
};

function isExitPlanDecision(value: unknown): value is ExitPlanDecision {
	return value === "execute" || value === "compactAndExecute" || value === "keepPlanning" || value === "cancelled";
}

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
	const details = result.details as unknown;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return theme.fg("dim", resultText(result));
	}
	const decision = (details as Record<string, unknown>).decision;
	if (!isExitPlanDecision(decision)) return theme.fg("dim", resultText(result));
	const rawPlanPath = (details as Record<string, unknown>).planPath;

	const lines: string[] = [];
	if (typeof rawPlanPath === "string" && rawPlanPath) {
		lines.push(theme.fg("dim", `Saved to ${shortenPlanPath(rawPlanPath)}`));
	}
	const decisionColor = decision === "cancelled" ? "warning" : "text";
	lines.push(theme.fg(decisionColor, DECISION_SUMMARY[decision]));
	return lines.join("\n");
}
