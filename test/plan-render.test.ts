import { beforeAll, describe, expect, test } from "vitest";
import type { AgentToolResult, ExtensionContext } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { ExitPlanDetails, PlanKickoffDetails } from "../src/extensions/plan/schema.ts";
import {
	formatApprovalSubtitle,
	formatExitPlanResult,
	renderExitPlanCall,
	renderPlanKickoffMessage,
	shortenPlanPath,
} from "../src/extensions/plan/view.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const recordingTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bold: (text: string) => text,
} as unknown as Theme;

const PLAN_BODY = "# Subagent regression fix\n\n## Goal\n\nFix the **five** issues.\n\n- Preserve behavior";

function result(details: ExitPlanDetails | undefined, text = "Model-facing text."): AgentToolResult<ExitPlanDetails> {
	return { content: [{ type: "text", text }], details } as AgentToolResult<ExitPlanDetails>;
}

function renderedCall(
	args: Parameters<typeof renderExitPlanCall>[0],
	expanded: boolean,
	width = 100,
): { lines: string[]; text: string } {
	const lines = renderExitPlanCall(args, theme, expanded)
		.render(width)
		.map((line) => stripAnsi(line).trimEnd());
	return { lines, text: lines.join("\n") };
}

function context(percent: number | null, contextWindow: number): ExtensionContext {
	return {
		getContextUsage: () => ({ tokens: percent == null ? null : 58_800, percent, contextWindow }),
	} as unknown as ExtensionContext;
}

beforeAll(() => initTheme("dark"));

describe("renderExitPlanCall", () => {
	test("collapsed shows the title and never the plan body", () => {
		const output = renderedCall({ title: "Fix subagent regression", plan: PLAN_BODY }, false);
		expect(output.lines).toEqual(["exit_plan Fix subagent regression"]);
		expect(output.text).not.toContain("Goal");
	});

	test("expanded renders the plan as Markdown and keeps the revision target dim", () => {
		const output = renderedCall({ title: "Fix subagent regression", plan: PLAN_BODY, revises: "01-old.md" }, true);
		expect(output.text).toContain("revises 01-old.md");
		expect(output.text).toContain("Goal");
		expect(output.text).toContain("Fix the five issues.");
		expect(output.text).toContain("- Preserve behavior");
		expect(output.text).not.toContain("## Goal");
		expect(output.text).not.toContain("**five**");
	});

	test("survives partial args while the call streams", () => {
		expect(renderedCall(undefined, false).text).toBe("exit_plan …");
		expect(renderedCall({}, true).text).toBe("exit_plan …");
		expect(renderedCall({ title: 42, plan: null }, true).text).toBe("exit_plan …");
	});
});

describe("formatApprovalSubtitle", () => {
	test("shows precise context pressure and the model window", () => {
		expect(formatApprovalSubtitle(context(29.37, 200_000))).toBe("Context 29.4% of 200k");
	});

	test("omits unavailable usage or window data", () => {
		expect(formatApprovalSubtitle(context(null, 200_000))).toBeUndefined();
		expect(formatApprovalSubtitle(context(29.37, 0))).toBe("Context 29.4%");
	});
});

describe("formatExitPlanResult", () => {
	test("makes the decision primary and the saved path secondary", () => {
		const text = formatExitPlanResult(
			result({ decision: "compactAndExecute", title: "t", planPath: "/tmp/plans/sid/01-fix.md" }),
			recordingTheme,
		);
		expect(text).toBe(
			"[dim]Saved to /tmp/plans/sid/01-fix.md[/dim]\n[text]Compacting context, then executing[/text]",
		);
	});

	test("omits the path for decisions that save nothing", () => {
		const text = formatExitPlanResult(result({ decision: "keepPlanning", title: "t" }), theme);
		expect(text).toBe("Still planning");
	});

	test("renders a stale cancellation as a warning", () => {
		const text = formatExitPlanResult(result({ decision: "cancelled", title: "t" }), recordingTheme);
		expect(text).toBe("[warning]No approval was pending[/warning]");
	});

	test("falls back safely for malformed historical details", () => {
		const unknownDecision = result(
			{ decision: "future", title: "t" } as unknown as ExitPlanDetails,
			"Historical plan result",
		);
		expect(formatExitPlanResult(unknownDecision, theme)).toBe("Historical plan result");

		const invalidPath = result({
			decision: "execute",
			title: "t",
			planPath: 42,
		} as unknown as ExitPlanDetails);
		expect(formatExitPlanResult(invalidPath, theme)).toBe("Executing with full context");
	});

	test("never echoes the model-facing result text when details are present", () => {
		const text = formatExitPlanResult(
			result({ decision: "execute", title: "t", planPath: "/tmp/01-fix.md" }, "Write tools are restored..."),
			theme,
		);
		expect(text).not.toContain("Write tools are restored");
	});

	test("falls back to the result text when details are missing", () => {
		expect(formatExitPlanResult(result(undefined, "Approval was interrupted."), theme)).toBe(
			"Approval was interrupted.",
		);
	});
});

describe("shortenPlanPath", () => {
	const home = process.env.USERPROFILE || process.env.HOME || "";

	test("collapses the home prefix", () => {
		if (!home) return;
		expect(shortenPlanPath(`${home}/.pi/agent/plans/sid/01-fix.md`)).toBe("~/.pi/agent/plans/sid/01-fix.md");
	});

	test("leaves paths outside home untouched", () => {
		expect(shortenPlanPath("/var/tmp/01-fix.md")).toBe("/var/tmp/01-fix.md");
	});
});

describe("renderPlanKickoffMessage", () => {
	const KICKOFF_BODY = `Execute the approved plan "Fix rewind" (saved at /p/20260728-1444-rewind.md).\n\n# Goal\n\nHarden restore.\n\nStart now.`;

	function kickoffMessage(overrides?: Partial<CustomMessage<PlanKickoffDetails>>): CustomMessage<PlanKickoffDetails> {
		return {
			role: "custom",
			customType: "plan-kickoff",
			content: KICKOFF_BODY,
			display: true,
			details: { title: "Fix rewind", planPath: "/p/20260728-1444-rewind.md" },
			timestamp: 0,
			...overrides,
		};
	}

	function rendered(message: CustomMessage<PlanKickoffDetails>, expanded: boolean): string {
		return renderPlanKickoffMessage(message, { expanded, outputPad: 0 }, theme)
			.render(100)
			.map((line) => stripAnsi(line).trimEnd())
			.join("\n");
	}

	test("collapsed shows the title card with the expand hint, never the plan body", () => {
		const text = rendered(kickoffMessage(), false);
		expect(text).toContain('plan Executing "Fix rewind"');
		expect(text).toContain("/p/20260728-1444-rewind.md");
		expect(text).toContain("to expand");
		expect(text).not.toContain("Goal");
	});

	test("expanded renders the full kickoff markdown without the hint", () => {
		const text = rendered(kickoffMessage(), true);
		expect(text).toContain('plan Executing "Fix rewind"');
		expect(text).toContain("Goal");
		expect(text).toContain("Harden restore.");
		expect(text).not.toContain("to expand");
	});

	test("survives missing details and array content", () => {
		const text = rendered(
			kickoffMessage({ details: undefined, content: [{ type: "text", text: "# Goal\n\nBody" }] }),
			true,
		);
		expect(text).toContain('plan Executing "plan"');
		expect(text).toContain("Body");
	});
});
