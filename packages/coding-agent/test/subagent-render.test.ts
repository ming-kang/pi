import { beforeAll, describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import type { SubagentDetails, SubagentRunDetails } from "../src/extensions/subagent/types.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function run(overrides: Partial<SubagentRunDetails> = {}): SubagentRunDetails {
	return {
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
		...overrides,
	};
}

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		mode: "parallel",
		status: "completed",
		startedAt: 0,
		endedAt: 1_500,
		usage: { turns: 2, toolUses: 3, input: 20, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0 },
		runs: [run()],
		...overrides,
	};
}

function collapsed(data: SubagentDetails, isPartial = false): string {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "done" }], details: data },
		{ expanded: false, isPartial },
		theme,
		false,
	);
	return component.render(120).join("\n");
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

	it("flags a call that provides multiple modes instead of guessing one", () => {
		const component = renderSubagentCall(
			{ prompt: "unused", tasks: [{ description: "task", prompt: "p" }], chain: null },
			theme,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("invalid · prompt + tasks");
		expect(output).not.toContain("parallel");
	});

	it("renders collapsed progress, usage, and the configured expansion hint", () => {
		const output = collapsed(details());
		expect(output).toContain("1/1 complete");
		expect(output).toContain("explorer · Map the code");
		expect(output).toContain("3 tool uses");
		expect(output).toContain("to expand");
	});

	it("collapses a completed single run to a clean response excerpt", () => {
		const output = collapsed(
			details({
				mode: "single",
				runs: [run({ finalOutput: "**Summary:** found `entry.ts`\n\n[Output truncated: 233 bytes omitted.]" })],
			}),
		);
		expect(output).toContain("Summary: found entry.ts");
		expect(output).not.toContain("**");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toMatch(/^completed$/mu);
		expect(output).not.toContain("explorer · Map the code");
	});

	it("shows the current activity and live tail while a single run is in flight", () => {
		const output = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						currentActivity: "Run ls -d */",
						liveText: "Scanning packages\nThe **workspace** has five extensions",
						finalOutput: "",
					}),
				],
			}),
			true,
		);
		expect(output).toContain("Run ls -d */");
		expect(output).toContain("The workspace has five extensions");
		expect(output).not.toContain("to expand");
	});

	it("keeps running tasks visible in a partial parallel batch", () => {
		const runs = [
			run({ id: "1", agent: "a1", description: "one" }),
			run({ id: "2", agent: "a2", description: "two" }),
			run({ id: "3", agent: "a3", description: "three" }),
			run({ id: "4", agent: "a4", description: "four" }),
			run({ id: "5", agent: "a5", description: "five", status: "running", currentActivity: "reading files" }),
		];
		const output = collapsed(details({ status: "running", endedAt: undefined, runs }), true);
		expect(output).toContain("a5 · five");
		expect(output).toContain("reading files");
		expect(output).toContain("+1 more");
	});

	it("prefixes chain steps and surfaces failures on the run line", () => {
		const output = collapsed(
			details({
				mode: "chain",
				runs: [
					run({ step: 1, finalOutput: "First done." }),
					run({
						step: 2,
						agent: "reviewer",
						description: "Review it",
						status: "failed",
						error: "boom",
						finalOutput: "",
					}),
				],
			}),
		);
		expect(output).toContain("1. explorer");
		expect(output).toContain("2. reviewer");
		expect(output).toContain("— boom");
	});

	it("drops markdown tables and rules from collapsed excerpts", () => {
		const output = collapsed(
			details({
				mode: "single",
				runs: [
					run({
						finalOutput:
							"结果如下。\n\n| 类型 | 名称 |\n|------|------|\n| 📁 | .git |\n\n────────\n\n总结：完成。",
					}),
				],
			}),
		);
		expect(output).not.toContain("|");
		expect(output).not.toContain("───");
		expect(output).toContain("结果如下。");
		expect(output).toContain("总结：完成。");
	});

	it("labels idle gaps between activities like the streaming state", () => {
		const output = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", currentActivity: undefined, liveText: "", finalOutput: "" })],
			}),
			true,
		);
		expect(output).toContain("Thinking…");
		expect(output).not.toMatch(/\bthinking\b/u);
	});

	it("expands a single run without repeating the call header or usage", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [
						run({
							startedAt: 0,
							endedAt: 4_000,
							activities: [
								{
									id: "call-1",
									toolName: "bash",
									summary: "Run ls -la",
									status: "succeeded",
									startedAt: 0,
									endedAt: 100,
									resultSummary: "total 383 drwxr-xr-x\n[Output truncated: 1121 bytes omitted.]",
								},
							],
						}),
					],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).not.toContain("explorer · Map the code");
		expect(output).not.toContain("[Output truncated");
		expect(output.match(/tool use/gu)).toHaveLength(1);
		expect(output).toContain("4.0s");
	});
});
