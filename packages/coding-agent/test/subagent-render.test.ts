import { beforeAll, describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function details(): SubagentDetails {
	return {
		mode: "parallel",
		status: "completed",
		startedAt: 0,
		endedAt: 1_500,
		usage: { turns: 2, toolUses: 3, input: 20, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0 },
		runs: [
			{
				id: "subagent-1",
				agent: "explorer",
				agentSource: "builtin",
				description: "Map the code",
				prompt: "Inspect the code.",
				cwd: "/project",
				model: "test/model",
				thinking: "low",
				status: "completed",
				activities: [],
				liveText: "",
				finalOutput: "Found the entry point.",
				usage: {
					turns: 1,
					toolUses: 2,
					input: 10,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 60,
					cost: 0,
				},
			},
		],
	};
}

describe("subagent rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("renders a compact call header without owning the native tool shell", () => {
		const component = renderSubagentCall(
			{
				tasks: [
					{ agent: "explorer", description: "Map the code", prompt: "Inspect" },
					{ agent: "reviewer", description: "Review design", prompt: "Review" },
				],
			},
			theme,
		);
		expect(component.render(120).join("\n")).toContain("parallel · 2 tasks");
	});

	it("renders collapsed progress, usage, and the configured expansion hint", () => {
		const component = renderSubagentResult(
			{ content: [{ type: "text", text: "done" }], details: details() },
			{ expanded: false, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("1/1 complete");
		expect(output).toContain("explorer · Map the code");
		expect(output).toContain("3 tool uses");
		expect(output).toContain("to expand");
	});
});
