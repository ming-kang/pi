import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import type { SubagentParams } from "../src/extensions/subagent/schema.ts";
import type {
	SubagentDetails,
	SubagentRunDetails,
	SubagentUsage,
	ToolActivity,
} from "../src/extensions/subagent/types.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function usage(overrides: Partial<SubagentUsage> = {}): SubagentUsage {
	return {
		turns: 1,
		toolUses: 2,
		input: 10,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 60,
		cost: 0,
		...overrides,
	};
}

function withRetry(
	run: SubagentRunDetails,
	attempt: number,
	maxAttempts: number,
	delayMs: number,
	error: string,
): SubagentRunDetails {
	run.retry = { attempt, maxAttempts, deadline: Date.now() + delayMs, error };
	run.currentActivity = `Retrying (${attempt}/${maxAttempts})...`;
	return run;
}

function run(overrides: Partial<SubagentRunDetails> = {}): SubagentRunDetails {
	return {
		id: "subagent-1",
		agent: "explorer",
		description: "Map the code",
		cwd: "",
		model: "test/model",
		thinking: "low",
		status: "completed",
		startedAt: 0,
		endedAt: 1_500,
		activities: [],
		report: "Found the entry point.",
		usage: usage(),
		...overrides,
	};
}

function liveRun(overrides: Partial<SubagentRunDetails> = {}): SubagentRunDetails {
	return run({
		status: "running",
		startedAt: Date.now() - 1_500,
		endedAt: undefined,
		currentActivity: undefined,
		report: "",
		...overrides,
	});
}

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		status: "completed",
		startedAt: 0,
		endedAt: 1_500,
		usage: usage({ turns: 2, toolUses: 3, input: 20, output: 100, totalTokens: 120 }),
		runs: [run()],
		...overrides,
	};
}

const defaultArgs: SubagentParams = { tasks: [{ agent: "explorer", prompt: "Inspect the code." }] };

interface RenderOptions {
	expanded?: boolean;
	isPartial?: boolean;
	args?: SubagentParams;
	isError?: boolean;
	width?: number;
}

function renderLines(data: SubagentDetails, options: RenderOptions = {}): string[] {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "done" }], details: data },
		{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
		theme,
		options.args ?? defaultArgs,
		options.isError ?? false,
	);
	return component.render(options.width ?? 120).map((line) => stripAnsi(line).trimEnd());
}

function collapsed(data: SubagentDetails, options: Omit<RenderOptions, "expanded"> = {}): string {
	return renderLines(data, { ...options, expanded: false }).join("\n");
}

function expanded(data: SubagentDetails, options: Omit<RenderOptions, "expanded"> = {}): string {
	return renderLines(data, { ...options, expanded: true }).join("\n");
}

function runningActivity(id: string, toolName: string, summary: string): ToolActivity {
	return { id, toolName, summary, status: "running", startedAt: Date.now() - 500 };
}

describe("subagent rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps the call header free of task counts before runtime details arrive", () => {
		const single = renderSubagentCall({ tasks: [{ agent: "explorer", prompt: "Inspect" }] }, theme);
		const batch = renderSubagentCall(
			{
				tasks: [
					{ agent: "explorer", prompt: "Inspect" },
					{ agent: "general", prompt: "Review" },
				],
			},
			theme,
		);
		expect(single.render(120).join("\n").trim()).toBe("Subagent");
		expect(batch.render(120).join("\n").trim()).toBe("Subagent");
		expect(single.render(120).join("\n")).not.toContain("task");
		expect(batch.render(120).join("\n")).not.toContain(" · ");
	});

	it("flags an empty tasks list in the call header color", () => {
		const colors: string[] = [];
		const trackingTheme = {
			...theme,
			fg: (color: string, text: string) => {
				colors.push(color);
				return text;
			},
		} as Theme;
		renderSubagentCall({ tasks: [] }, trackingTheme).render(120);
		expect(colors).toContain("error");
	});

	it("keeps prompts out of collapsed legacy rows and falls back to the run description when expanded", () => {
		const legacyArgs = { agent: "explorer", prompt: "Old shape" } as unknown as SubagentParams;
		const settled = collapsed(details({ runs: [run({ report: "Found it." })] }), { args: legacyArgs });
		expect(settled).toBe("✓ #1 Explorer");
		expect(settled).not.toContain("Map the code");
		expect(settled).not.toContain("Old shape");

		const running = collapsed(details({ status: "running", endedAt: undefined, runs: [liveRun()] }), {
			isPartial: true,
			args: legacyArgs,
		});
		expect(running).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(running).not.toContain("Thinking");
		expect(running).not.toContain("Map the code");

		const expandedOutput = expanded(details({ runs: [run({ report: "Found it." })] }), { args: legacyArgs });
		expect(expandedOutput).toContain("Prompt");
		expect(expandedOutput).toContain("Map the code");
		expect(expandedOutput).not.toContain("Old shape");
	});

	it("collapses settled results to ordered status rows without an aggregate line", () => {
		const output = collapsed(
			details({
				usage: usage({ turns: 2, toolUses: 7, totalTokens: 120, cost: 0.42 }),
				runs: [
					run(),
					run({ id: "r2", agent: "general", status: "failed", error: "nope", report: "" }),
					run({ id: "r3", agent: "general", status: "aborted", report: "" }),
				],
			}),
		);
		expect(output).toBe("✓ #1 Explorer · × #2 General · ■ #3 General");
		expect(output).not.toContain("completed · 1 failed");
		expect(output).not.toContain("$0.420");
		expect(output).not.toContain("nope");
		expect(output).not.toContain("Inspect the code");
	});

	it("keeps settled collapsed output free of reports, activities, and truncation notices", () => {
		const output = collapsed(
			details({
				runs: [
					run({
						report: "**Summary:** found `entry.ts`\n\n[Output truncated: 233 bytes omitted.]",
						activities: [{ id: "a1", toolName: "read", summary: "read a.ts", status: "succeeded", startedAt: 0 }],
					}),
				],
			}),
		);
		expect(output).toBe("✓ #1 Explorer");
		expect(output).not.toContain("Summary");
		expect(output).not.toContain("Output truncated");
		expect(output).not.toContain("Read a.ts");
		expect(output).not.toContain("Prompt");
		expect(output).not.toContain("Report");
	});

	it("colors each settled row marker by its own outcome", () => {
		const colors: string[] = [];
		const trackingTheme = {
			...theme,
			fg: (color: string, text: string) => {
				colors.push(`${color}:${text}`);
				return text;
			},
		} as Theme;
		renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: details({
					runs: [run(), run({ status: "failed" }), run({ status: "aborted" })],
				}),
			},
			{ expanded: false, isPartial: false },
			trackingTheme,
			defaultArgs,
			false,
		).render(120);
		expect(colors).toContain("success:✓");
		expect(colors).toContain("error:×");
		expect(colors).toContain("warning:■");
	});

	it("omits duration for a terminal row that never started", () => {
		const output = collapsed(
			details({
				status: "aborted",
				runs: [run({ status: "aborted", startedAt: undefined, endedAt: undefined, report: "" })],
			}),
		);
		expect(output).toBe("■ #1 Explorer");
	});

	it("formats per-run minute boundaries without emitting sixty seconds", () => {
		const output = expanded(
			details({
				runs: [
					run({ endedAt: 75_000 }),
					run({ id: "r2", agent: "general", endedAt: 119_600 }),
					run({ id: "r3", agent: "general", endedAt: 59_600 }),
				],
			}),
		);
		expect(output).toContain("── #1 Explorer · test/model · low · 2 tool uses · 1 turn · 1m 15s");
		expect(output).toContain("── #2 General · test/model · low · 2 tool uses · 1 turn · 2m 0s");
		expect(output).toContain("── #3 General · test/model · low · 2 tool uses · 1 turn · 1m 0s");
		expect(output).not.toMatch(/\b60s\b/u);
	});

	it("keeps collapsed rows to the status glyph, ordinal, and profile only", () => {
		const active = liveRun({
			currentActivity: "Run ls -d */",
			activities: [runningActivity("bash-1", "bash", "Run ls -d */")],
		});
		const output = collapsed(details({ status: "running", endedAt: undefined, runs: [active] }), {
			isPartial: true,
		});
		expect(output).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(output).not.toContain("Run ls -d */");
		expect(output).not.toContain("0/1");
		expect(output).not.toContain("Inspect the code");
		expect(output).not.toContain("Prompt");
	});

	it("normalizes every built-in worker tool to a direct activity verb", () => {
		const activities = [
			runningActivity("bash", "bash", "Run npm test"),
			runningActivity("read", "read", "read src/index.ts"),
			runningActivity("grep", "grep", "Search normalizeState"),
			runningActivity("find", "find", "Find **/*.test.ts"),
			runningActivity("ls", "ls", "ls src"),
			runningActivity("edit", "edit", "edit src/index.ts"),
			runningActivity("write", "write", "write docs/design.md"),
		];
		const runs = activities.map((activity, index) =>
			liveRun({ id: `r${index + 1}`, agent: index === 6 ? "general" : "explorer", activities: [activity] }),
		);
		const output = expanded(details({ status: "running", endedAt: undefined, runs }), {
			isPartial: true,
			args: {
				tasks: runs.map((entry) => ({ agent: entry.agent as "explorer" | "general", prompt: "Hidden" })),
			},
		});
		expect(output).toContain("› Run npm test");
		expect(output).toContain("› Read src/index.ts");
		expect(output).toContain("› Search normalizeState");
		expect(output).toContain("› Find **/*.test.ts");
		expect(output).toContain("› List src");
		expect(output).toContain("› Edit src/index.ts");
		expect(output).toContain("› Write docs/design.md");
	});

	it("shows auto-compaction as its own running state", () => {
		const compacting = liveRun({
			currentActivity: "Compacting context…",
			activities: [runningActivity("compaction", "compaction", "Compacting context…")],
		});
		const folded = collapsed(details({ status: "running", endedAt: undefined, runs: [compacting] }), {
			isPartial: true,
		});
		expect(folded).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(folded).not.toContain("Compacting");

		const open = expanded(details({ status: "running", endedAt: undefined, runs: [compacting] }), {
			isPartial: true,
		});
		expect(open).toContain("› Compacting...");
	});

	it("shows settled compaction sizes and failed reasons in live Activity history", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					liveRun({
						activities: [
							{
								id: "compaction-1",
								toolName: "compaction",
								summary: "Compacted 244k → 48k",
								status: "succeeded",
								startedAt: 0,
								endedAt: 12_000,
							},
							{
								id: "compaction-2",
								toolName: "compaction",
								summary: "Compact context",
								status: "failed",
								startedAt: 12_000,
								endedAt: 15_000,
								resultSummary: "Auto-compaction failed: Nothing to compact",
							},
						],
					}),
				],
			}),
			{ isPartial: true },
		);
		expect(output).toContain("Compacted 244k → 48k · 12s");
		expect(output).toContain("× Compact context · Auto-compaction failed: Nothing to compact");
	});

	it("keeps every mixed-state row in original ordinal order", () => {
		const runs = [
			run({ id: "1" }),
			liveRun({ id: "2", agent: "general", activities: [runningActivity("bash", "bash", "Run check")] }),
			run({ id: "3", status: "failed", error: "nope", report: "" }),
			run({ id: "4", agent: "general", status: "aborted", report: "" }),
			liveRun({ id: "5", status: "queued", startedAt: undefined }),
			liveRun({ id: "6" }),
		];
		const output = collapsed(details({ status: "running", endedAt: undefined, runs }), {
			isPartial: true,
			args: { tasks: runs.map((entry) => ({ agent: entry.agent as "explorer" | "general", prompt: "Hidden" })) },
		});
		for (let index = 1; index < runs.length; index++) {
			expect(output.indexOf(`#${index}`)).toBeLessThan(output.indexOf(`#${index + 1}`));
		}
		expect(output).toContain("✓ #1 Explorer");
		expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #2 General/u);
		expect(output).toContain("× #3 Explorer");
		expect(output).toContain("■ #4 General");
		expect(output).toContain("○ #5 Explorer");
		expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #6 Explorer/u);
		expect(output).not.toContain("done");
	});

	it("uses the current activity fallback without reclassifying its command", () => {
		const output = collapsed(
			details({ status: "running", endedAt: undefined, runs: [liveRun({ currentActivity: "Run git status" })] }),
			{ isPartial: true },
		);
		expect(output).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(output).not.toContain("git status");
	});

	it("labels queued, starting, and idle model states", () => {
		const queued = liveRun({ status: "queued", startedAt: undefined });
		const starting = liveRun({ usage: usage({ turns: 0, toolUses: 0, totalTokens: 0 }) });
		const thinking = liveRun();
		const output = collapsed(details({ status: "running", endedAt: undefined, runs: [queued, starting, thinking] }), {
			isPartial: true,
			args: {
				tasks: [
					{ agent: "explorer", prompt: "Queued" },
					{ agent: "explorer", prompt: "Starting" },
					{ agent: "explorer", prompt: "Thinking" },
				],
			},
		});
		expect(output).toContain("○ #1 Explorer");
		expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #2 Explorer/u);
		expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #3 Explorer/u);
		expect(output).not.toContain("Queued");
		expect(output).not.toContain("Starting");
		expect(output).not.toContain("Thinking");
	});

	it.each([60, 80, 120])("stays width-safe while wrapping a wide batch at %i columns", (width) => {
		const runs = Array.from({ length: 12 }, (_, index) => liveRun({ id: `r${index}` }));
		const lines = renderLines(details({ status: "running", endedAt: undefined, runs }), {
			isPartial: true,
			width,
			args: {
				tasks: runs.map((entry) => ({ agent: "explorer", prompt: `Prompt ${entry.id}` })),
			},
		});
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).not.toContain("�");
			expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
		}
	});

	it("aligns every continuation row to the same columns", () => {
		const runs = Array.from({ length: 6 }, (_, index) => liveRun({ id: `r${index}` }));
		const lines = renderLines(details({ status: "running", endedAt: undefined, runs }), {
			isPartial: true,
			width: 60,
			args: {
				tasks: runs.map((entry) => ({ agent: "explorer", prompt: `Prompt ${entry.id}` })),
			},
		});
		expect(lines).toHaveLength(2);
		expect(visibleWidth(lines[0]!)).toBe(visibleWidth(lines[1]!));
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			expect(line).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #[1-6] Explorer/u);
		}
	});

	it("never leaks prompt heads or markdown into collapsed task rows", () => {
		const prompt = `# **中文摘要：** 通过 [链接](https://example.com) 找到 \`entry.ts\` — ${"🚀".repeat(100)}`;
		const output = collapsed(details({ status: "running", endedAt: undefined, runs: [liveRun()] }), {
			isPartial: true,
			args: { tasks: [{ agent: "explorer", prompt }] },
		});
		expect(output).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(output).not.toContain("中文摘要");
		expect(output).not.toContain("链接");
		expect(output).not.toContain("entry.ts");
		expect(output).not.toContain("🚀");
	});

	it("keeps collapsed rows free of retry countdowns and shows them expanded", () => {
		const retrying = withRetry(liveRun({ currentActivity: "Exploring code" }), 1, 3, 8_000, "fetch failed");
		const folded = collapsed(details({ status: "running", endedAt: undefined, runs: [retrying] }), {
			isPartial: true,
		});
		expect(folded).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Explorer$/u);
		expect(folded).not.toContain("Retrying");
		expect(folded).not.toContain("Exploring code");
		const open = expanded(details({ status: "running", endedAt: undefined, runs: [retrying] }), {
			isPartial: true,
		});
		expect(open).toContain("› Retrying (1/3) in 8s · fetch failed");
	});

	it("keeps task-level retry backoff out of collapsed rows", () => {
		const retrying = withRetry(liveRun({ status: "queued", startedAt: undefined }), 1, 2, 8_000, "fetch failed");
		const folded = collapsed(details({ status: "running", endedAt: undefined, runs: [retrying] }), {
			isPartial: true,
		});
		expect(folded).toBe("○ #1 Explorer");
		const open = expanded(details({ status: "running", endedAt: undefined, runs: [retrying] }), {
			isPartial: true,
		});
		expect(open).toContain("○ Retrying (1/2) in 8s · fetch failed");
	});

	it("keeps terminal failure reasons out of compact rows", () => {
		const omitted = "OMITTED_ERROR_TAIL";
		const error = `${"failure context ".repeat(20)}${omitted}`;
		const output = collapsed(
			details({
				status: "failed",
				runs: [run({ report: "First done." }), run({ id: "r2", status: "failed", error, report: "" })],
			}),
			{
				isPartial: true,
				args: {
					tasks: [
						{ agent: "explorer", prompt: "First." },
						{ agent: "explorer", prompt: "Second." },
					],
				},
			},
		);
		expect(output).toContain("✓ #1 Explorer");
		expect(output).toContain("× #2 Explorer");
		expect(output).not.toContain("failure context");
		expect(output).not.toContain(omitted);
	});

	it("keeps batch timing and cost out of collapsed rows and shows them expanded", () => {
		const data = details({
			status: "failed",
			startedAt: 0,
			endedAt: 4_000,
			usage: usage({ turns: 2, toolUses: 7, totalTokens: 120, cost: 0.42 }),
			runs: [run({ status: "failed", error: "nope", report: "" }), run({ id: "r2", agent: "general" })],
		});
		const folded = collapsed(data);
		expect(folded).toBe("× #1 Explorer · ✓ #2 General");
		expect(folded).not.toContain("$0.420");
		expect(folded).not.toContain("4.0s");
		const open = expanded(data);
		expect(open).toContain("── Batch · 2 tasks · 4.0s · $0.420");
	});

	it("expands a settled task into compact metadata, full prompt, and report", () => {
		const output = expanded(
			details({
				startedAt: 0,
				endedAt: 4_000,
				runs: [
					run({
						startedAt: 0,
						endedAt: 4_000,
						report: "**Summary:** found `entry.ts`",
					}),
				],
			}),
		);
		expect(output).toContain("── Batch · 1 task · 4.0s");
		expect(output).toContain("── #1 Explorer · test/model · low · 2 tool uses · 1 turn · 4.0s");
		expect(output).toContain("Prompt");
		expect(output).toContain("Inspect the code.");
		expect(output).toContain("Report");
		expect(output).toContain("Summary: found entry.ts");
		expect(output).not.toContain("low thinking");
		expect(output).not.toContain("60 tok");
		expect(output).not.toContain("$0.");
		expect(output).not.toContain("✓ Explorer");
	});

	it("renders the complete original prompt from call args when expanded", () => {
		const output = expanded(details({ runs: [run({ report: "Done." })] }), {
			args: { tasks: [{ agent: "explorer", prompt: "Line one\n\nLine two\nLine three\nLine four" }] },
		});
		expect(output).toContain("Line one");
		expect(output).toContain("Line two");
		expect(output).toContain("Line three");
		expect(output).toContain("Line four");
		expect(output).not.toContain("continues");
	});

	it("falls back to the run description when args carry no matching task", () => {
		const output = expanded(
			details({
				runs: [run({ report: "Done." }), run({ id: "r2", agent: "general", description: "Fallback briefing" })],
			}),
			{ args: { tasks: [{ agent: "explorer", prompt: "Inspect the code." }] } },
		);
		expect(output).toContain("Inspect the code.");
		expect(output).toContain("Fallback briefing");
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
		renderSubagentResult(
			{ content: [{ type: "text", text: "done" }], details: details({ runs: [run({ report: "Plain prose." })] }) },
			{ expanded: true, isPartial: false },
			trackingTheme,
			defaultArgs,
			false,
		).render(120);
		expect(colors).toContain("toolOutput");
	});

	it("labels a failed run's partial report and separates its error", () => {
		const output = expanded(
			details({
				status: "failed",
				runs: [
					run({
						status: "failed",
						error: "worker crashed mid-flight",
						report: "Got halfway through the migration.",
					}),
				],
			}),
			{ isError: true },
		);
		expect(output).toContain("── #1 Explorer · test/model · low · 2 tool uses · 1 turn · 1.5s");
		expect(output).toContain("Error");
		expect(output).toContain("worker crashed mid-flight");
		expect(output).toContain("Report · partial");
		expect(output).toContain("Got halfway through the migration.");
	});

	it("does not label an empty failed report as partial", () => {
		const output = expanded(
			details({
				status: "failed",
				runs: [run({ status: "failed", error: "worker failed", report: "" })],
			}),
			{ isError: true },
		);
		expect(output).toContain("Report");
		expect(output).toContain("(No report.)");
		expect(output).not.toContain("Report · partial");
	});

	it("numbers expanded batch sections without repeating prompt summaries", () => {
		const output = expanded(
			details({
				runs: [run(), run({ id: "subagent-2", agent: "general", report: "Looks fine." })],
			}),
			{
				args: {
					tasks: [
						{ agent: "explorer", prompt: "Inspect the code." },
						{ agent: "general", prompt: "Review the design." },
					],
				},
			},
		);
		expect(output).toContain("── #1 Explorer · test/model · low · 2 tool uses · 1 turn · 1.5s");
		expect(output).toContain("── #2 General · test/model · low · 2 tool uses · 1 turn · 1.5s");
		expect(output.match(/Prompt/gu)).toHaveLength(2);
		expect(output.match(/Report/gu)).toHaveLength(2);
		expect(output.match(/Inspect the code\./gu)).toHaveLength(1);
		expect(output.match(/Review the design\./gu)).toHaveLength(1);
	});

	it("shows full prompts and Activity for active and queued runs", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					liveRun({
						currentActivity: "Run check",
						usage: usage({ toolUses: 3, totalTokens: 1_250, cost: 0.012, contextTokens: 1_250 }),
						activities: [
							{ id: "read-1", toolName: "read", summary: "read a.ts", status: "succeeded", startedAt: 0 },
							runningActivity("bash-1", "bash", "Run check"),
						],
					}),
					liveRun({
						id: "subagent-2",
						agent: "general",
						status: "queued",
						startedAt: undefined,
						usage: usage({ turns: 0, toolUses: 0, totalTokens: 0 }),
					}),
				],
			}),
			{
				isPartial: true,
				args: {
					tasks: [
						{ agent: "explorer", prompt: "Inspect the renderer fully." },
						{ agent: "general", prompt: "Review the renderer fully." },
					],
				},
			},
		);
		expect(output).toContain("── #1 Explorer · test/model · low · 3 tool uses · 1 turn");
		expect(output).toContain("Inspect the renderer fully.");
		expect(output).toContain("Activity · last 2 of 3");
		expect(output).toContain("Read a.ts");
		expect(output).toContain("› Run check");
		expect(output).toContain("── #2 General · test/model · low");
		expect(output).toContain("Review the renderer fully.");
		expect(output).toContain("  Queued");
		expect(output).not.toContain("0/2 done");
		expect(output).not.toContain("ctx:");
		expect(output).not.toContain("$0.012");
		expect(output).not.toContain("Report");
	});

	it("shows a terminal run's Report immediately while sibling tasks remain active", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ report: "First task report." }), liveRun({ id: "r2", agent: "general" })],
			}),
			{
				isPartial: true,
				args: {
					tasks: [
						{ agent: "explorer", prompt: "First full prompt." },
						{ agent: "general", prompt: "Second full prompt." },
					],
				},
			},
		);
		expect(output).toContain("First full prompt.");
		expect(output).toContain("First task report.");
		expect(output).toContain("Second full prompt.");
		expect(output).toContain("Activity");
	});

	it("shows a retry exactly once under Activity when no tool has started", () => {
		const retrying = withRetry(liveRun({ activities: [] }), 1, 2, 8_000, "temporary failure");
		const output = expanded(details({ status: "running", endedAt: undefined, runs: [retrying] }), {
			isPartial: true,
		});
		expect(output.match(/Retrying \(1\/2\) in 8s/gu)).toHaveLength(1);
		expect(output).toContain("› Retrying (1/2) in 8s · temporary failure");
		expect(output).toContain("Prompt");
	});

	it("keeps settled Activity rows quiet and annotates only long ones", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					liveRun({
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
			{ isPartial: true },
		);
		expect(output).toContain("  Run ls -la");
		expect(output).toContain("  Read entry.ts · 12s");
		expect(output).not.toContain("✓ Run ls -la");
		expect(output).not.toContain("total 383");
		expect(output).not.toContain("Output truncated");
		expect(output).not.toContain("· 1.2s");
	});

	it("shows a bounded failed Activity excerpt and preserves literal truncation markers", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					liveRun({
						activities: [
							{
								id: "fail-1",
								toolName: "bash",
								summary: "Run check",
								status: "failed",
								startedAt: 0,
								resultSummary: "exit 1: The marker [Output truncated.] is part of this failure.",
							},
						],
					}),
				],
			}),
			{ isPartial: true },
		);
		expect(output).toContain("× Run check");
		expect(output).toContain("exit 1: The marker [Output truncated.] is part of this failure.");

		const bounded = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					liveRun({
						activities: [
							{
								id: "fail-2",
								toolName: "bash",
								summary: "Run check",
								status: "failed",
								startedAt: 0,
								resultSummary: "error ".repeat(40),
							},
						],
					}),
				],
			}),
			{ isPartial: true },
		);
		expect(bounded).toContain("…");
		expect(bounded).not.toContain("�");
	});

	it("falls back to bounded result text and labels empty details as Starting", () => {
		const renderFallback = (result: { content: Array<{ type: string; text?: string }>; details: unknown }): string =>
			renderSubagentResult(
				result as Parameters<typeof renderSubagentResult>[0],
				{ expanded: false, isPartial: false },
				theme,
				defaultArgs,
				false,
			)
				.render(120)
				.join("\n");

		expect(renderFallback({ content: [{ type: "text", text: "nope" }], details: undefined })).toContain("nope");
		expect(renderFallback({ content: [{ type: "text", text: "broken" }], details: { runs: "bad" } })).toContain(
			"broken",
		);
		expect(renderFallback({ content: [], details: undefined })).toContain("(no output)");
		expect(renderFallback({ content: [{ type: "text", text: "x" }], details: details({ runs: [] }) })).toContain(
			"Starting...",
		);
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
				defaultArgs,
				isError,
			).render(120);
			return colors;
		};
		expect(renderNoDetails(true)).toContain("error");
		expect(renderNoDetails(false)).toContain("muted");
	});

	it("bounds the no-details fallback by code point", () => {
		const output = renderSubagentResult(
			{ content: [{ type: "text", text: "🚀".repeat(5_000) }], details: undefined as unknown as SubagentDetails },
			{ expanded: false, isPartial: false },
			theme,
			defaultArgs,
			false,
		)
			.render(120)
			.join("\n");
		expect(output).toContain("…");
		expect([...output].length).toBeLessThan(5_000);
		expect(output).not.toContain("�");
		expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
	});
});
