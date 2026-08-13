import { beforeAll, describe, expect, it } from "vitest";
import { renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import { beginSubagentRetry } from "../src/extensions/subagent/retry.ts";
import type { SubagentParams } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails, SubagentRunDetails, SubagentUsage } from "../src/extensions/subagent/types.ts";
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

function collapsed(
	data: SubagentDetails,
	isPartial = false,
	args: SubagentParams = defaultArgs,
	isError = false,
): string {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "done" }], details: data },
		{ expanded: false, isPartial },
		theme,
		args,
		isError,
	);
	return stripAnsi(component.render(120).join("\n"));
}

function expanded(
	data: SubagentDetails,
	isPartial = false,
	args: SubagentParams = defaultArgs,
	isError = false,
): string {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "done" }], details: data },
		{ expanded: true, isPartial },
		theme,
		args,
		isError,
	);
	return stripAnsi(component.render(120).join("\n"));
}

describe("subagent rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("labels task-only call args with the task count", () => {
		const single = renderSubagentCall({ tasks: [{ agent: "explorer", prompt: "Inspect" }] }, theme);
		expect(single.render(120).join("\n")).toContain("Subagent · 1 task");
		const batch = renderSubagentCall(
			{
				tasks: [
					{ agent: "explorer", prompt: "Inspect" },
					{ agent: "general", prompt: "Review" },
				],
			},
			theme,
		);
		expect(batch.render(120).join("\n")).toContain("Subagent · 2 tasks");
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

	it("falls back to the run description for legacy args without a tasks array", () => {
		// Tool calls restored from before the tasks-array shape carry the old
		// single-task args object; summaries and the prompt section must use
		// the stored run description instead of throwing.
		const legacyArgs = { agent: "explorer", prompt: "Old shape" } as unknown as SubagentParams;
		const settled = collapsed(details({ runs: [run({ report: "Found it." })] }), false, legacyArgs);
		expect(settled).toContain("Map the code");
		expect(settled).not.toContain("Old shape");
		const running = collapsed(
			details({ status: "running", endedAt: undefined, runs: [run({ status: "running", endedAt: undefined })] }),
			true,
			legacyArgs,
		);
		expect(running).toContain("Map the code");
		expect(running).not.toContain("Old shape");
		const expandedOutput = expanded(details({ runs: [run({ report: "Found it." })] }), false, legacyArgs);
		expect(expandedOutput).toContain("Map the code");
		expect(expandedOutput).not.toContain("Old shape");
	});

	it("collapses settled results to the aggregate outcome, cost, and duration", () => {
		const output = collapsed(
			details({
				usage: usage({ turns: 2, toolUses: 7, totalTokens: 120, cost: 0.42 }),
				runs: [
					run(),
					run({
						id: "r2",
						agent: "general",
						description: "Review it",
						status: "failed",
						error: "nope",
						report: "",
					}),
					run({ id: "r3", agent: "general", description: "Clean up", status: "aborted", report: "" }),
				],
			}),
		);
		expect(output).toContain("1 completed · 1 failed · 1 aborted · 1.5s · $0.420");
		expect(output).toContain("✓ Explorer · Inspect the code. · 1.5s");
		expect(output).toContain("× General · Review it · 1.5s");
		expect(output).toContain("■ General · Clean up · 1.5s");
		expect(output).not.toContain("nope");
		expect(output).not.toContain("tok");
		expect(output).not.toContain("tool use");
		expect(output).not.toContain("turn");
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
		expect(output).toContain("1 completed · 1.5s");
		expect(output).toContain("✓ Explorer · Inspect the code. · 1.5s");
		expect(output).not.toContain("Summary");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toContain("read a.ts");
		expect(output).not.toContain("Prompt");
		expect(output).not.toContain("Report");
	});

	it("colors the collapsed settled summary marker by the batch outcome", () => {
		const renderColors = (data: SubagentDetails): string[] => {
			const colors: string[] = [];
			const trackingTheme = {
				...theme,
				fg: (color: string, text: string) => {
					colors.push(color);
					return text;
				},
			} as Theme;
			renderSubagentResult(
				{ content: [{ type: "text", text: "done" }], details: data },
				{ expanded: false, isPartial: false },
				trackingTheme,
				defaultArgs,
				false,
			).render(120);
			return colors;
		};
		const succeeded = renderColors(details());
		expect(succeeded).toContain("success");
		expect(succeeded).not.toContain("error");
		expect(succeeded).not.toContain("warning");
		expect(renderColors(details({ runs: [run({ status: "failed", error: "nope", report: "" })] }))).toContain(
			"error",
		);
		const aborted = renderColors(details({ runs: [run({ status: "aborted", report: "" })] }));
		expect(aborted).toContain("warning");
		expect(aborted).not.toContain("error");
	});

	it("omits the duration tail for settled rows that never started", () => {
		const output = collapsed(
			details({
				status: "aborted",
				runs: [run({ status: "aborted", startedAt: undefined, endedAt: undefined, report: "" })],
			}),
		);
		expect(output).toContain("■ Explorer · Inspect the code.");
		expect(output).not.toContain("Inspect the code. ·");
	});

	it("formats minute boundaries without emitting sixty seconds", () => {
		const output = expanded(
			details({
				startedAt: 0,
				endedAt: 75_000,
				runs: [
					run({ endedAt: 75_000 }),
					run({ id: "r2", agent: "general", description: "Review it", endedAt: 119_600 }),
					run({ id: "r3", agent: "general", description: "Clean up", endedAt: 59_600 }),
				],
			}),
		);
		expect(output).toContain("3 completed · 1m 15s");
		expect(output).toContain("2m 0s");
		expect(output).toContain("1m 0s");
		expect(output).not.toMatch(/\b60s\b/u);
	});

	it("shows the aggregate, the task row, and the current activity while a task runs", () => {
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						currentActivity: "Run ls -d */",
						activities: [
							{ id: "bash-1", toolName: "bash", summary: "Run ls -d */", status: "running", startedAt: 0 },
						],
						report: "",
					}),
				],
			}),
			true,
		);
		expect(output).toContain("0/1 done");
		expect(output).toContain("› Explorer · Inspect the code. — Run ls -d */");
		expect(output).not.toContain("tok");
		expect(output).not.toContain("●");
		expect(output).not.toContain("Prompt");
		expect(output).not.toContain("Report");
	});

	it("counts running and queued tasks in the collapsed header", () => {
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({ status: "running", endedAt: undefined, currentActivity: "Reading files", report: "" }),
					run({
						id: "r2",
						agent: "general",
						description: "Check build",
						status: "queued",
						startedAt: undefined,
						endedAt: undefined,
						report: "",
					}),
					run({ id: "r3", agent: "general", description: "Review it", status: "completed" }),
				],
			}),
			true,
			{
				tasks: [
					{ agent: "explorer", prompt: "Inspect A." },
					{ agent: "general", prompt: "Check B." },
					{ agent: "general", prompt: "Review C." },
				],
			},
		);
		expect(output).toContain("1/3 done");
		expect(output).toContain("› Explorer · Inspect A. — Reading files");
		expect(output).toContain("○ General · Check B. — Waiting for a worker slot");
		expect(output).toContain("✓ General · Review C. · 1.5s");
	});

	it("shows every task row in original order while running", () => {
		const runs = [
			run({ id: "1", description: "one" }),
			run({ id: "2", agent: "general", description: "two" }),
			run({ id: "3", description: "three" }),
			run({ id: "4", agent: "general", description: "four" }),
			run({
				id: "5",
				agent: "general",
				description: "five",
				status: "running",
				endedAt: undefined,
				currentActivity: "reading files",
				report: "",
			}),
			run({
				id: "6",
				agent: "explorer",
				description: "six",
				status: "running",
				endedAt: undefined,
				currentActivity: "fetching data",
				report: "",
			}),
		];
		const output = collapsed(details({ status: "running", endedAt: undefined, runs }), true, {
			tasks: runs.map((entry, index) => ({
				agent: entry.agent as "explorer" | "general",
				prompt: `Task ${index + 1}`,
			})),
		});
		expect(output).toContain("4/6 done");
		expect(output).toContain("✓ Explorer · Task 1 · 1.5s");
		expect(output).toContain("✓ General · Task 4 · 1.5s");
		expect(output).toContain("› General · Task 5 — reading files");
		expect(output).toContain("› Explorer · Task 6 — fetching data");
		// Rows keep the original task order even while later tasks are active.
		expect(output.indexOf("Task 1")).toBeLessThan(output.indexOf("Task 5"));
		expect(output).not.toContain("+2 more");
		expect(output).not.toContain("#5");
	});

	it("shows the current activity verbatim instead of reclassifying it", () => {
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", endedAt: undefined, currentActivity: "Run git status", report: "" })],
			}),
			true,
		);
		expect(output).toContain("Run git status");
		expect(output).not.toContain("Exploring");
	});

	it("labels queued, starting, and idle running states", () => {
		const queued = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "queued", startedAt: undefined, endedAt: undefined, report: "" })],
			}),
			true,
		);
		expect(queued).toContain("Waiting for a worker slot");
		expect(queued).not.toContain("Initializing");

		const starting = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						report: "",
						usage: usage({ turns: 0, toolUses: 0, totalTokens: 0 }),
					}),
				],
			}),
			true,
		);
		expect(starting).toContain("Initializing…");
		expect(starting).not.toContain("Thinking");

		const idle = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", endedAt: undefined, currentActivity: undefined, report: "" })],
			}),
			true,
		);
		expect(idle).toContain("Thinking…");
	});

	it("truncates collapsed activity text by code point", () => {
		const currentActivity = "🚀".repeat(150);
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", endedAt: undefined, currentActivity, report: "" })],
			}),
			true,
		);
		expect(output).toContain("…");
		expect(output).not.toContain("�");
		expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
	});

	it("bounds collapsed task summaries from the prompt head", () => {
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", endedAt: undefined, currentActivity: "working", report: "" })],
			}),
			true,
			{ tasks: [{ agent: "explorer", prompt: "🚀".repeat(100) }] },
		);
		expect(output).toContain("…");
		expect(output).not.toContain("�");
	});

	it("strips inline markdown from collapsed task summaries while keeping code syntax", () => {
		const output = collapsed(
			details({
				status: "running",
				endedAt: undefined,
				runs: [run({ status: "running", endedAt: undefined, currentActivity: "working", report: "" })],
			}),
			true,
			{
				tasks: [
					{
						agent: "explorer",
						prompt:
							"# **Summary:** found `entry.ts` via [the link](https://example.com) — keep __init__ and __file__",
					},
				],
			},
		);
		expect(output).toContain("Summary: found entry.ts via the link — keep __init__ and __file__");
		expect(output).not.toMatch(/^#/mu);
		expect(output).not.toContain("**");
		expect(output).not.toContain("`");
		expect(output).not.toContain("[the link]");
	});

	it("prefers the retry countdown over the current activity in rows", () => {
		const retrying = run({ status: "running", endedAt: undefined, currentActivity: "Exploring code", report: "" });
		beginSubagentRetry(retrying, { attempt: 1, maxAttempts: 3, delayMs: 8_000, error: "fetch failed" });
		const output = collapsed(details({ status: "running", endedAt: undefined, runs: [retrying] }), true);
		expect(output).toContain("Retrying (1/3) in 8s — fetch failed");
		expect(output).not.toContain("Exploring code");
	});

	it("bounds failure reasons on collapsed running rows", () => {
		const omitted = "OMITTED_ERROR_TAIL";
		const error = `${"failure context ".repeat(20)}${omitted}`;
		const output = collapsed(
			details({
				status: "failed",
				runs: [
					run({ report: "First done." }),
					run({ id: "r2", agent: "general", description: "Review it", status: "failed", error, report: "" }),
				],
			}),
			true,
			{
				tasks: [
					{ agent: "explorer", prompt: "First." },
					{ agent: "general", prompt: "Review it." },
				],
			},
		);
		expect(output).toContain("× General · Review it. —");
		expect(output).toContain("…");
		expect(output).not.toContain(omitted);
	});

	it("expands a settled single task into prompt, metrics, and report", () => {
		const output = expanded(
			details({
				startedAt: 0,
				endedAt: 4_000,
				runs: [
					run({
						startedAt: 0,
						endedAt: 4_000,
						report: "**Summary:** found `entry.ts`",
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
		);
		expect(output).toContain("1 completed · 4.0s");
		expect(output).toContain("── #1 ✓ Explorer · Inspect the code.");
		expect(output).toContain("test/model · low thinking · 60 tok · 2 tool uses · 1 turn · 4.0s");
		expect(output).toContain("Prompt");
		expect(output).toContain("Inspect the code.");
		expect(output).toContain("Report");
		expect(output).toContain("Summary: found entry.ts");
		// Settled views never surface the activity list or its truncation
		// notices, and the report header is not the old "Response" label.
		expect(output).not.toContain("Activity");
		expect(output).not.toContain("Run ls -la");
		expect(output).not.toContain("read entry.ts");
		expect(output).not.toContain("Response");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toContain("Task");
	});

	it("renders the full original prompt from the call args when expanded", () => {
		const output = expanded(details({ runs: [run({ report: "Done." })] }), false, {
			tasks: [{ agent: "explorer", prompt: "Line one\n\nLine two\nLine three\nLine four" }],
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
				runs: [
					run({ report: "Done." }),
					run({ id: "r2", agent: "general", description: "Fallback briefing", report: "Done." }),
				],
			}),
			false,
			{ tasks: [{ agent: "explorer", prompt: "Inspect the code." }] },
		);
		expect(output).toContain("Prompt");
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
			{
				content: [{ type: "text", text: "done" }],
				details: details({ runs: [run({ report: "Plain report prose." })] }),
			},
			{ expanded: true, isPartial: false },
			trackingTheme,
			defaultArgs,
			false,
		).render(120);
		expect(colors).toContain("toolOutput");
	});

	it("labels a failed run's partial report and separates the error", () => {
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
			false,
			defaultArgs,
			true,
		);
		expect(output).toContain("1 failed · 1.5s");
		expect(output).toContain("── #1 × Explorer · Inspect the code.");
		expect(output).toContain("Error");
		expect(output).toContain("worker crashed mid-flight");
		expect(output).toContain("Report · partial");
		expect(output).toContain("Got halfway through the migration.");
		expect(output).not.toContain("Activity");
	});

	it("does not label an empty failed report as partial", () => {
		const output = expanded(
			details({
				status: "failed",
				runs: [run({ status: "failed", error: "worker failed", report: "" })],
			}),
			false,
			defaultArgs,
			true,
		);
		expect(output).toContain("Report");
		expect(output).toContain("(No report.)");
		expect(output).not.toContain("Report · partial");
	});

	it("numbers expanded batch sections and matches them to run headers", () => {
		const output = expanded(
			details({
				runs: [run(), run({ id: "subagent-2", agent: "general", description: "Review it", report: "Looks fine." })],
			}),
			false,
			{
				tasks: [
					{ agent: "explorer", prompt: "Inspect the code." },
					{ agent: "general", prompt: "Review the design." },
				],
			},
		);
		expect(output).toContain("2 completed · 1.5s");
		expect(output).toContain("── #1 ✓ Explorer · Inspect the code.");
		expect(output).toContain("── #2 ✓ General · Review the design.");
		expect(output).toContain("test/model · low thinking · 60 tok · 2 tool uses · 1 turn · 1.5s");
		expect(output.match(/Prompt/gu)).toHaveLength(2);
		expect(output.match(/Report/gu)).toHaveLength(2);
		expect(output).not.toContain("Activity");
		expect(output).not.toContain("●");
	});

	it("shows bounded activity, retry, and metrics while running without prompt or report", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						currentActivity: "Run check",
						report: "",
						usage: usage({ toolUses: 3, totalTokens: 1_250, cost: 0.012, contextTokens: 1_250 }),
						activities: [
							{ id: "read-1", toolName: "read", summary: "read a.ts", status: "succeeded", startedAt: 0 },
							{ id: "bash-1", toolName: "bash", summary: "Run check", status: "running", startedAt: 0 },
						],
					}),
					run({
						id: "subagent-2",
						agent: "general",
						description: "Review the renderer",
						status: "running",
						endedAt: undefined,
						currentActivity: "Initializing review",
						report: "",
						usage: usage({ turns: 0, toolUses: 0, totalTokens: 0 }),
					}),
				],
			}),
			true,
			{
				tasks: [
					{ agent: "explorer", prompt: "Inspect the renderer." },
					{ agent: "general", prompt: "Review the renderer." },
				],
			},
		);
		expect(output).toContain("0/2 done");
		expect(output).toContain("── #1 › Explorer · Inspect the renderer.");
		expect(output).toContain("3 tool uses · 1 turn · ctx: 1.3k · $0.012");
		expect(output).not.toContain("1.3k tok");
		expect(output).toContain("Activity · last 2 of 3");
		expect(output).toContain("read a.ts");
		expect(output).toContain("› Run check");
		expect(output).toContain("── #2 › General · Review the renderer.");
		expect(output).toContain("Initializing review");
		expect(output).not.toContain("Prompt");
		expect(output).not.toContain("Report");
	});

	it("shows a retry once when no activity has started", () => {
		const retrying = run({ status: "running", endedAt: undefined, activities: [], report: "" });
		beginSubagentRetry(retrying, { attempt: 1, maxAttempts: 2, delayMs: 8_000, error: "temporary failure" });
		const output = expanded(details({ status: "running", endedAt: undefined, runs: [retrying] }), true, defaultArgs);
		expect(output.match(/Retrying \(1\/2\) in 8s/gu)).toHaveLength(1);
		expect(output).toContain("Waiting to retry");
	});

	it("keeps settled activity rows quiet and annotates only long ones", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						currentActivity: "Running checks",
						report: "",
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
			true,
		);
		expect(output).toContain("Run ls -la");
		expect(output).toContain("read entry.ts · 12s");
		expect(output).not.toContain("✓ Run ls -la");
		expect(output).not.toContain("total 383");
		expect(output).not.toContain("[Output truncated");
		expect(output).not.toContain("· 1.2s");
	});

	it("shows a bounded failure excerpt and preserves literal truncation markers", () => {
		const output = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						report: "",
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
			true,
		);
		expect(output).toContain("× Run check");
		expect(output).toContain("exit 1: The marker [Output truncated.] is part of this failure.");

		const bounded = expanded(
			details({
				status: "running",
				endedAt: undefined,
				runs: [
					run({
						status: "running",
						endedAt: undefined,
						report: "",
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
			true,
		);
		expect(bounded).toContain("…");
		expect(bounded).not.toContain("�");
	});

	it("falls back to the result text when details are missing or malformed", () => {
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

		const missing = renderFallback({
			content: [{ type: "text", text: "nope" }],
			details: undefined as unknown as SubagentDetails,
		});
		expect(missing).toContain("nope");

		const notRuns = renderFallback({
			content: [{ type: "text", text: "broken" }],
			details: { runs: "not-an-array" } as unknown as SubagentDetails,
		});
		expect(notRuns).toContain("broken");

		const noText = renderFallback({ content: [], details: undefined as unknown as SubagentDetails });
		expect(noText).toContain("(no output)");

		const initializing = renderFallback({ content: [{ type: "text", text: "x" }], details: details({ runs: [] }) });
		expect(initializing).toContain("Initializing…");
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
