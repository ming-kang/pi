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
		cwd: "",
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
		expect(component.render(120).join("\n")).toContain("Multi-Agent · 2 tasks");
	});

	it("labels single calls with the capitalized agent name", () => {
		const component = renderSubagentCall({ agent: "code-reviewer", description: "Review the diff" }, theme);
		const output = component.render(120).join("\n");
		expect(output).toContain("Code Reviewer Agent · Review the diff");
		const defaulted = renderSubagentCall({ description: "Fix the bug" }, theme);
		expect(defaulted.render(120).join("\n")).toContain("General Agent · Fix the bug");
	});

	it("flags a call that provides multiple modes instead of guessing one", () => {
		const component = renderSubagentCall({ prompt: "unused", tasks: [{ description: "task", prompt: "p" }] }, theme);
		const output = component.render(120).join("\n");
		expect(output).toContain("invalid · prompt + tasks");
		expect(output).not.toContain("Multi-Agent");
	});

	it("renders collapsed progress, usage, and the configured expansion hint", () => {
		const output = collapsed(details());
		expect(output).toContain("1/1 complete");
		expect(output).not.toContain("0 running");
		expect(output).not.toContain("0 queued");
		expect(output).toContain("✓ 1 · Explorer · Map the code");
		expect(output).toContain("120 tok · 1.5s");
		expect(output).toContain("to expand");
	});

	it("formats minute boundaries without emitting sixty seconds", () => {
		const output = collapsed(
			details({
				runs: [
					run({ startedAt: 0, endedAt: 75_000 }),
					run({ id: "subagent-2", startedAt: 0, endedAt: 119_600 }),
					run({ id: "subagent-3", startedAt: 0, endedAt: 59_600 }),
				],
			}),
		);
		expect(output).toContain("1m 15s");
		expect(output).toContain("2m 0s");
		expect(output).toContain("1m 0s");
		expect(output).not.toMatch(/\b60s\b/u);
	});

	it("keeps the settled parallel footer to whole-call numbers", () => {
		const output = collapsed(
			details({
				usage: {
					turns: 2,
					toolUses: 7,
					input: 20,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 120,
					cost: 0,
				},
				runs: [
					run({
						activities: [
							{ id: "read-1", toolName: "read", summary: "read a.ts", status: "succeeded", startedAt: 0 },
							{ id: "read-2", toolName: "read", summary: "read b.ts", status: "succeeded", startedAt: 0 },
							{ id: "bash-1", toolName: "bash", summary: "run check", status: "succeeded", startedAt: 0 },
						],
					}),
				],
			}),
		);
		expect(output).toContain("120 tok");
		expect(output).not.toContain("Read 2 files");
		expect(output).not.toContain("read a.ts");
		expect(output).not.toContain("7 tool uses");
		expect(output).not.toContain("2 turns");
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
		expect(output).not.toContain("Explorer · Map the code");
		expect(output).toContain("120 tok · 3 tool uses · 1.5s");
	});

	it("uses sentence boundaries for completed batch excerpts", () => {
		const first = "The renderer keeps this complete sentence before trimming the rest of the successful report.";
		const output = collapsed(
			details({
				runs: [run({ finalOutput: `${first} Second sentence should stay out of the compact row.` })],
			}),
		);
		expect(output.replace(/\s+/gu, " ")).toContain(first);
		expect(output).not.toContain("Second sentence");
	});

	it("preserves literal truncation marker text in completed excerpts", () => {
		const output = collapsed(
			details({
				mode: "single",
				runs: [run({ finalOutput: "The marker [Output truncated.] is part of this finding." })],
			}),
		);
		expect(output).toContain("The marker [Output truncated.] is part of this finding.");
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
						activities: [
							{ id: "bash-1", toolName: "bash", summary: "Run ls -d */", status: "running", startedAt: 0 },
						],
						liveText: "Scanning packages\nThe **workspace** has five extensions",
						finalOutput: "",
					}),
				],
			}),
			true,
		);
		expect(output).toContain("Exploring code · 2 tool uses");
		expect(output).toContain("› Run ls -d */");
		expect(output).toContain("The workspace has five extensions");
		expect(output).not.toContain("tokens");
		expect(output).not.toContain("●");
		expect(output).not.toContain("to expand");
	});

	it("classifies inspection commands as exploration instead of generic command runs", () => {
		const output = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						finalOutput: "",
						liveText: "Checking the tree",
						activities: [
							{ id: "bash-1", toolName: "bash", summary: "Run git status", status: "running", startedAt: 0 },
						],
					}),
				],
			}),
			true,
		);
		expect(output).toContain("Exploring code");
		expect(output).not.toContain("Running commands");
	});

	it("bounds live intent text in single and batch rows", () => {
		const currentActivity = `Inspecting ${"renderer ".repeat(20)}`;
		const activeRun = run({
			status: "running",
			currentActivity,
			finalOutput: "",
			usage: { ...run().usage, toolUses: 1 },
		});
		const singleOutput = collapsed(
			details({ mode: "single", status: "running", endedAt: undefined, runs: [activeRun] }),
			true,
		);
		const batchOutput = collapsed(details({ status: "running", endedAt: undefined, runs: [activeRun] }), true);
		for (const output of [singleOutput, batchOutput]) {
			expect(output).toContain("Inspecting renderer");
			expect(output).toContain("…");
			expect(output).not.toContain(currentActivity);
		}
	});

	it("shows per-run live tool and context metrics for parallel work", () => {
		const runningDetails = details({
			status: "running",
			endedAt: undefined,
			runs: [
				run({
					status: "running",
					currentActivity: "Inspecting the renderer",
					finalOutput: "",
					usage: {
						turns: 1,
						toolUses: 3,
						input: 800,
						output: 400,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_250,
						cost: 0.012,
						contextTokens: 1_250,
					},
				}),
				run({
					id: "subagent-2",
					agent: "reviewer",
					description: "Review the renderer",
					status: "running",
					currentActivity: "Initializing review",
					finalOutput: "",
					usage: {
						turns: 0,
						toolUses: 0,
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: 0,
					},
				}),
			],
		});
		const output = collapsed(runningDetails, true);
		expect(output).toContain("3 tool uses · ctx: 1.3k · $0.012");
		expect(output).toContain("Reviewer · Review the renderer");
		expect(output).toContain("0 tool uses");
		expect(output).not.toContain("tokens");
		expect(output).not.toContain("●");
		expect(output).toContain("2 running");
		expect(output).not.toContain("0 queued");

		const component = renderSubagentResult(
			{ content: [{ type: "text", text: "in progress" }], details: runningDetails },
			{ expanded: true, isPartial: true },
			theme,
			false,
		);
		const expandedOutput = component.render(120).join("\n");
		expect(expandedOutput).toContain("3 tool uses · ctx: 1.3k");
		expect(expandedOutput).toContain("$0.012");
		// The batch trailer must not quote the cache-inflated aggregate
		// while any run is still in flight.
		expect(expandedOutput).not.toContain("120 tok");
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
		// The ordinal is the task position, not the display slot, so the
		// active-first reordering cannot scramble identity.
		expect(output).toContain("5 · A5 · five");
		expect(output).toContain("reading files");
		expect(output).toContain("+1 more");
	});

	it("puts batch failure reasons on a bounded, aligned line in collapsed and expanded views", () => {
		const omitted = "OMITTED_ERROR_TAIL";
		const error = `${"failure context ".repeat(20)}${omitted}`;
		const failedDetails = details({
			status: "failed",
			runs: [
				run({ finalOutput: "First done." }),
				run({
					agent: "reviewer",
					description: "Review it",
					status: "failed",
					error,
					finalOutput: "",
				}),
			],
		});
		const assertWrappedError = (lines: string[], failureIndex: number) => {
			const wrapped: string[] = [];
			for (let index = failureIndex + 1; index < lines.length; index++) {
				const line = lines[index] ?? "";
				if (!line.trim() || !line.startsWith("      ")) break;
				wrapped.push(line);
			}
			expect(wrapped.length).toBeGreaterThan(1);
			expect(wrapped.every((line) => line.startsWith("      "))).toBe(true);
			const excerpt = wrapped.map((line) => line.trim()).join(" ");
			expect(excerpt).toMatch(/…$/u);
			expect(excerpt).not.toContain(omitted);
		};

		const output = collapsed(failedDetails);
		const collapsedLines = output.split("\n");
		const collapsedFailure = collapsedLines.findIndex((line) => line.includes("× 2 · Reviewer · Review it"));
		expect(collapsedFailure).toBeGreaterThanOrEqual(0);
		assertWrappedError(collapsedLines, collapsedFailure);
		expect(collapsedLines[collapsedFailure]).not.toContain("—");

		const expanded = renderSubagentResult(
			{ content: [{ type: "text", text: "failed" }], details: failedDetails },
			{ expanded: true, isPartial: false },
			theme,
			true,
		)
			.render(120)
			.join("\n");
		const expandedLines = expanded.split("\n");
		const expandedFailure = expandedLines.findIndex((line) => line.includes("× 2 · Reviewer · Review it"));
		expect(expandedFailure).toBeGreaterThanOrEqual(0);
		assertWrappedError(expandedLines, expandedFailure);
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

	it("uses Initializing… only after a single worker begins starting", () => {
		const queuedOutput = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "queued", finalOutput: "" })],
			}),
			true,
		);
		const startingOutput = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						liveText: "",
						finalOutput: "",
						usage: {
							turns: 0,
							toolUses: 0,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: 0,
						},
					}),
				],
			}),
			true,
		);
		expect(queuedOutput).toContain("Queued");
		expect(queuedOutput).not.toContain("Initializing…");
		expect(startingOutput).toContain("Initializing…");

		const abortedOutput = collapsed(
			details({
				mode: "single",
				status: "aborted",
				runs: [run({ status: "aborted", error: undefined, finalOutput: "" })],
			}),
		);
		expect(abortedOutput).toContain("Aborted");
		expect(abortedOutput).not.toMatch(/^aborted$/mu);
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

	it("expands a single run into a report cover sheet without repeating the call header", () => {
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
									endedAt: 1_200,
									resultSummary: "total 383 drwxr-xr-x\n[Output truncated: 1121 bytes omitted.]",
								},
								{
									id: "call-2",
									toolName: "read",
									summary: "read entry.ts",
									status: "succeeded",
									startedAt: 1_200,
									endedAt: 13_000,
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
		expect(output).toContain("✓ Completed · test/model · low thinking");
		expect(output).toContain("60 tok · 2 tool uses · 1 turn · 4.0s");
		expect(output).toContain("Prompt");
		expect(output).toContain("Inspect the code.");
		expect(output).toContain("Report");
		expect(output).not.toContain("Response");
		expect(output).not.toContain("Task");
		expect(output).not.toContain("Explorer · Map the code");
		expect(output).not.toContain("──");
		// Success rows are quiet one-liners: no glyph, no result echo, and
		// durations only when they explain where the time went.
		expect(output).toContain("Run ls -la");
		const activityLines = output.split("\n");
		expect(activityLines.find((line) => line.includes("Run ls -la"))?.startsWith("  ")).toBe(true);
		expect(activityLines.find((line) => line.includes("read entry.ts"))?.startsWith("  ")).toBe(true);
		expect(output).not.toContain("✓ Run ls -la");
		expect(output).not.toContain("total 383");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toContain("· 1.2s");
		expect(output).toContain("read entry.ts · 12s");
	});

	it("renders report prose with the tool output base color", () => {
		const colors: string[] = [];
		const trackingTheme = {
			...theme,
			fg: (color: string, text: string) => {
				colors.push(color);
				return text;
			},
		} as Theme;
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({ mode: "single", runs: [run({ finalOutput: "Plain report prose." })] }),
			},
			{ expanded: true, isPartial: false },
			trackingTheme,
			false,
		);
		component.render(120);
		expect(colors).toContain("toolOutput");
	});

	it("numbers the expanded batch contents and matches them to section headers", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					runs: [
						run(),
						run({ id: "subagent-2", agent: "reviewer", description: "Review it", finalOutput: "Looks fine." }),
					],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("✓ 1 · Explorer · Map the code");
		expect(output).toContain("✓ 2 · Reviewer · Review it");
		expect(output).toContain("── 1 · ✓ Explorer · Map the code");
		expect(output).toContain("── 2 · ✓ Reviewer · Review it");
		expect(output).toContain("test/model · low · 60 tok");
		expect(output).toContain("120 tok · 3 tool uses · 2 turns · 1.5s");
		expect(output.match(/Report/gu)).toHaveLength(2);
		expect(output).not.toContain("●");
	});

	it("keeps the live tail visible in the expanded view while a run streams", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "in progress" }],
				details: details({
					mode: "single",
					status: "running",
					endedAt: undefined,
					runs: [
						run({
							status: "running",
							finalOutput: "",
							liveText: "First finding\nSecond finding\nThe retry loop lives in runner.ts",
						}),
					],
				}),
			},
			{ expanded: true, isPartial: true },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("› Running · test/model · low thinking");
		expect(output).toContain("Working");
		expect(output).toContain("Second finding");
		expect(output).toContain("The retry loop lives in runner.ts");
	});

	it("never surfaces a truncation notice as the live tail line", () => {
		const output = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						finalOutput: "",
						liveText: "[Earlier output omitted.]\nNewest streamed line\n\n[Output truncated: 999 bytes omitted.]",
					}),
				],
			}),
			true,
		);
		expect(output).toContain("Newest streamed line");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toContain("[Earlier output omitted");
		expect(output).not.toMatch(/^…$/mu);
	});

	it("preserves live lines that only begin like a truncation notice", () => {
		const output = collapsed(
			details({
				mode: "single",
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						finalOutput: "",
						liveText: "Previous line\n[Output truncated.] is a literal finding",
					}),
				],
			}),
			true,
		);
		expect(output).toContain("[Output truncated.] is a literal finding");
	});

	it("omits the thinking segment when thinking is off", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({ mode: "single", runs: [run({ thinking: "off" })] }),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("✓ Completed · test/model");
		expect(output).not.toContain("off");
	});

	it("previews the prompt head, skipping blank lines, and counts the rest", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [run({ prompt: "Line one\n\nLine two\nLine three\nLine four" })],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("Line one");
		expect(output).toContain("Line two");
		expect(output).not.toContain("Line three");
		expect(output).toContain("… continues, 2 more lines");
	});

	it("marks a one-line prompt clipped mid-sentence as continuing", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [run({ prompt: `Quick: ${"survey the repository and report ".repeat(8)}` })],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(200).join("\n");
		expect(output).toContain("… continues");
		expect(output).not.toContain("more lines");
	});

	it("marks a capped prompt preview without leaking the truncation notice", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [run({ prompt: "Briefing head\n\n[Output truncated: 900 bytes omitted.]" })],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("Briefing head");
		expect(output).toContain("… continues · capped at 1KB");
		expect(output).not.toContain("[Output truncated");
	});

	it("preserves literal prompt markers without claiming the prompt was capped", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [run({ prompt: "Explain this literal marker:\n[Output truncated.]\nContinue the analysis" })],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("Explain this literal marker:");
		expect(output).toContain("[Output truncated.]");
		expect(output).toContain("… continues, 1 more line");
		expect(output).not.toContain("capped at 1KB");
	});

	it("selects prompt preview lines after removing markdown-only lines", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [
						run({
							prompt:
								"| Name | Value |\n| --- | --- |\n```ts\nconst value = 1;\n```\nExplain the value\nFinal note",
						}),
					],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("const value = 1;");
		expect(output).toContain("Explain the value");
		expect(output).not.toContain("Final note");
		expect(output).toContain("… continues, 1 more line");
	});

	it("labels a failed run's partial output and separates the error", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "failed" }],
				details: details({
					mode: "single",
					status: "failed",
					runs: [
						run({
							status: "failed",
							error: "worker crashed mid-flight",
							finalOutput: "Got halfway through the migration.",
						}),
					],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			true,
		);
		const output = component.render(120).join("\n");
		expect(output).toContain("× Failed · test/model · low thinking");
		expect(output).toContain("Error");
		expect(output).toContain("worker crashed mid-flight");
		expect(output).toContain("Report · partial");
	});

	it("labels a clipped activity list with the retained window", () => {
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					mode: "single",
					runs: [
						run({
							usage: {
								turns: 2,
								toolUses: 5,
								input: 10,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 60,
								cost: 0,
							},
							activities: [
								{ id: "read-1", toolName: "read", summary: "read a.ts", status: "succeeded", startedAt: 0 },
								{ id: "read-2", toolName: "read", summary: "read b.ts", status: "succeeded", startedAt: 0 },
							],
						}),
					],
				}),
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		expect(component.render(120).join("\n")).toContain("Activity · last 2 of 5");
	});

	it("truncates by code point so emoji never split into replacement glyphs", () => {
		const output = collapsed(
			details({
				mode: "single",
				runs: [run({ finalOutput: "🚀".repeat(250) })],
			}),
		);
		expect(output).toContain("…");
		expect(output).not.toContain("�");
		expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
	});

	it("preserves code syntax while stripping bold markup in excerpts", () => {
		const output = collapsed(
			details({
				mode: "single",
				runs: [
					run({
						finalOutput:
							'def __init__(self):\nvalue = x**2**3\npath = __file__\nif __name__ == "__main__": return __doc__\n**Summary:** found it\n__bold__ and __WARNING:__',
					}),
				],
			}),
		);
		expect(output).toContain("__init__");
		expect(output).toContain("__file__");
		expect(output).toContain("__name__");
		expect(output).toContain('"__main__"');
		expect(output).toContain("__doc__");
		expect(output).toContain("x**2**3");
		expect(output).toContain("Summary: found it");
		expect(output).toContain("bold and");
		expect(output).toContain("WARNING:");
		expect(output).not.toContain("**Summary");
		expect(output).not.toContain("__bold__");
		expect(output).not.toContain("__WARNING");
	});

	it("colors the no-details fallback by the error state", () => {
		const renderNoDetails = (isError: boolean): string[] => {
			const colors: string[] = [];
			const trackingTheme = {
				...theme,
				fg: (color: string, text: string) => {
					colors.push(color);
					return text;
				},
			} as Theme;
			renderSubagentResult(
				{ content: [{ type: "text", text: "nope" }], details: undefined as unknown as SubagentDetails },
				{ expanded: false, isPartial: false },
				trackingTheme,
				isError,
			).render(120);
			return colors;
		};
		expect(renderNoDetails(true)).toContain("error");
		expect(renderNoDetails(false)).toContain("muted");
	});
});
