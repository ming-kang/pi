import { describe, expect, test } from "vitest";
import type { AgentToolResult } from "../src/core/extensions/types.ts";
import type { ExitPlanDetails } from "../src/extensions/plan/schema.ts";
import { formatExitPlanCall, formatExitPlanResult, shortenPlanPath } from "../src/extensions/plan/view.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const PLAN_BODY = "# Subagent regression fix\n\n## Goal\n\nFix the five issues.";

function result(details: ExitPlanDetails | undefined, text = "Model-facing text."): AgentToolResult<ExitPlanDetails> {
	return { content: [{ type: "text", text }], details } as AgentToolResult<ExitPlanDetails>;
}

describe("formatExitPlanCall", () => {
	test("collapsed shows the title and never the plan body", () => {
		const line = formatExitPlanCall({ title: "Fix subagent regression", plan: PLAN_BODY }, theme, false);
		expect(line).toBe("exit_plan Fix subagent regression");
		expect(line).not.toContain("Goal");
		expect(line).not.toContain("\n");
	});

	test("expanded appends the plan body and the revision target", () => {
		const text = formatExitPlanCall(
			{ title: "Fix subagent regression", plan: PLAN_BODY, revises: "01-old.md" },
			theme,
			true,
		);
		expect(text).toContain("revises 01-old.md");
		expect(text).toContain("## Goal");
		expect(text).toContain("Fix the five issues.");
	});

	test("survives partial args while the call streams", () => {
		expect(formatExitPlanCall(undefined, theme, false)).toBe("exit_plan …");
		expect(formatExitPlanCall({}, theme, true)).toBe("exit_plan …");
		expect(formatExitPlanCall({ title: 42, plan: null }, theme, true)).toBe("exit_plan …");
	});
});

describe("formatExitPlanResult", () => {
	test("reports where the plan landed and what happens next", () => {
		const text = formatExitPlanResult(
			result({ decision: "compactAndExecute", title: "t", planPath: "/tmp/plans/sid/01-fix.md" }),
			theme,
		);
		expect(text).toContain("Saved to /tmp/plans/sid/01-fix.md");
		expect(text).toContain("Compacting context, then executing");
	});

	test("omits the path for decisions that save nothing", () => {
		const text = formatExitPlanResult(result({ decision: "keepPlanning", title: "t" }), theme);
		expect(text).toBe("Still planning");
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
