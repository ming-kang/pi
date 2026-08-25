import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import type { SubagentParamsSchema } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails, SubagentRunDetails } from "../src/extensions/subagent/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SPINNER_CLASS = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

function registeredSubagentTool(): ToolDefinition<typeof SubagentParamsSchema, SubagentDetails> {
	let definition: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails> | undefined;
	const api = {
		registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) => {
			definition = tool;
		},
		registerCommand: () => {},
		on: () => {},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	subagent(api);
	if (!definition) throw new Error("Subagent tool was not registered");
	return definition;
}

function usage(toolUses = 1) {
	return {
		turns: 1,
		toolUses,
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: 0,
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
	run.currentActivity = `Retrying (${attempt}/${maxAttempts})…`;
	return run;
}

function runningRun(id: string, startedAt: number): SubagentRunDetails {
	return {
		id,
		agent: "explorer",
		description: `Inspect ${id}`,
		cwd: process.cwd(),
		model: "test/model",
		thinking: "low",
		status: "running",
		startedAt,
		currentActivity: "Exploring code",
		activities: [],
		report: "",
		usage: usage(),
	};
}

function runningDetails(startedAt: number, runCount = 1): SubagentDetails {
	const runs = Array.from({ length: runCount }, (_, index) => runningRun(`run-${index + 1}`, startedAt));
	return {
		status: "running",
		startedAt,
		runs,
		usage: usage(runCount),
	};
}

function completedDetails(startedAt: number, endedAt: number): SubagentDetails {
	const run = runningRun("run-1", startedAt);
	run.status = "completed";
	run.endedAt = endedAt;
	run.currentActivity = undefined;
	run.report = "Completed report.";
	return {
		status: "completed",
		startedAt,
		endedAt,
		runs: [run],
		usage: usage(),
	};
}

function fakeTui(requestRender: () => void = () => {}): TUI {
	return { requestRender } as unknown as TUI;
}

function createComponent(
	definition: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>,
	id: string,
	args: Record<string, unknown>,
	requestRender?: () => void,
): ToolExecutionComponent {
	return new ToolExecutionComponent("subagent", id, args, {}, definition, fakeTui(requestRender), process.cwd());
}

function render(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(160).join("\n"));
}

describe("Subagent shell-driven live refresh", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the collapsed call header quiet and animates the flow while running", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const requestRender = vi.fn();
		const component = createComponent(
			definition,
			"subagent-live-single",
			{
				tasks: [{ agent: "explorer", prompt: "Inspect silently." }],
			},
			requestRender,
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "running" }], details: runningDetails(0), isError: false },
			true,
		);

		const initial = render(component);
		expect(initial).toContain("● Subagent");
		expect(initial).toMatch(new RegExp(`${SPINNER_CLASS} #1 Explorer`, "u"));
		expect(initial).not.toContain("0.0s");
		expect(initial).not.toContain("Running…");

		vi.advanceTimersByTime(3000);
		const after = render(component);
		expect(after).toMatch(new RegExp(`${SPINNER_CLASS} #1 Explorer`, "u"));
		expect(after).not.toContain("3.0s");
		expect(after).not.toContain("Running…");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("3.0s");
		expect(expanded).toContain("── Batch · 1 task");
		expect(expanded).not.toContain("Running…");

		component.updateResult(
			{
				content: [{ type: "text", text: "Completed report." }],
				details: completedDetails(0, 3000),
				isError: false,
			},
			false,
		);
		component.setExpanded(false);
		const settled = render(component);
		expect(settled).toContain("● Subagent");
		expect(settled).toContain("✓ #1 Explorer");
		expect(settled).not.toContain("3.0s");
		const settledRenderRequests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(5000);
		expect(render(component)).toBe(settled);
		expect(requestRender).toHaveBeenCalledTimes(settledRenderRequests);
		component.dispose();
	});

	it("moves aggregate timing and cost into the expanded batch summary", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const component = createComponent(definition, "subagent-title-summary", {
			tasks: [{ agent: "explorer", prompt: "Inspect silently." }],
		});
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "starting" }],
				details: { status: "running", startedAt: 0, runs: [], usage: usage(0) },
				isError: false,
			},
			true,
		);
		expect(render(component)).toContain("● Subagent");
		expect(render(component)).toContain("Starting...");

		vi.advanceTimersByTime(1000);
		component.updateResult(
			{ content: [{ type: "text", text: "running" }], details: runningDetails(1000), isError: false },
			true,
		);
		vi.advanceTimersByTime(2000);

		const finalDetails = completedDetails(1000, 3000);
		finalDetails.usage.cost = 0.042;
		finalDetails.runs[0]!.usage.cost = 0.042;
		component.updateResult(
			{ content: [{ type: "text", text: "done" }], details: finalDetails, isError: false },
			false,
		);
		expect(render(component)).toContain("● Subagent");
		expect(render(component)).toContain("✓ #1 Explorer");
		component.setExpanded(true);
		const settled = render(component);
		expect(settled).toContain("── Batch · 1 task · 2.0s · $0.042");
		expect(settled).not.toContain("1 completed");
		component.dispose();
	});

	it("reconstructs batch timing and cost from a settled result without prior partial state", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const definition = registeredSubagentTool();
		const component = createComponent(definition, "subagent-restored-settled", {
			tasks: [{ agent: "explorer", prompt: "Inspect silently." }],
		});
		const restored = completedDetails(1_000, 4_000);
		restored.usage.cost = 0.007;
		restored.runs[0]!.usage.cost = 0.007;
		component.updateResult({ content: [{ type: "text", text: "done" }], details: restored, isError: false }, false);
		expect(render(component)).toContain("● Subagent");
		expect(render(component)).toContain("✓ #1 Explorer");
		component.setExpanded(true);
		const output = render(component);
		expect(output).toContain("── Batch · 1 task · 3.0s · $0.007");
		expect(output).toContain("── #1 Explorer · test/model · low");
		component.dispose();
	});

	it("refreshes retry deadlines through the same shell clock", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const retrying = runningDetails(0);
		withRetry(retrying.runs[0]!, 1, 3, 8_000, "fetch failed");
		const component = createComponent(definition, "subagent-live-retry", {
			tasks: [{ agent: "explorer", prompt: "Inspect silently." }],
		});
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "retrying" }], details: retrying, isError: false },
			true,
		);

		expect(render(component)).toMatch(new RegExp(`${SPINNER_CLASS} #1 Explorer`, "u"));
		expect(render(component)).not.toContain("Retrying");
		component.setExpanded(true);
		expect(render(component)).toContain("Retrying (1/3) in 8s · fetch failed");
		vi.advanceTimersByTime(1000);
		component.invalidate();
		expect(render(component)).toContain("Retrying (1/3) in 7s · fetch failed");
		vi.advanceTimersByTime(6000);
		component.invalidate();
		expect(render(component)).toContain("Retrying (1/3) in 1s · fetch failed");
		vi.advanceTimersByTime(1000);
		component.invalidate();
		expect(render(component)).toContain("Retrying (1/3) now... · fetch failed");
		component.dispose();
	});

	it("shows queued task retry countdowns in expanded batches only", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const retrying = runningDetails(0, 4);
		const retryingRun = retrying.runs.at(-1)!;
		retryingRun.status = "queued";
		retryingRun.startedAt = undefined;
		withRetry(retryingRun, 1, 2, 8_000, "fetch failed");
		const component = createComponent(definition, "subagent-task-retry", {
			tasks: Array.from({ length: 4 }, (_, index) => ({
				agent: "explorer",
				prompt: `Inspect task ${index + 1}.`,
			})),
		});
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "retrying" }], details: retrying, isError: false },
			true,
		);

		const folded = render(component);
		expect(folded).toContain("○ #4 Explorer");
		expect(folded).not.toContain("Retrying");
		component.setExpanded(true);
		expect(render(component)).toContain("○ Retrying (1/2) in 8s · fetch failed");
		vi.advanceTimersByTime(1000);
		component.invalidate();
		expect(render(component)).toContain("Retrying (1/2) in 7s · fetch failed");
		component.dispose();
	});

	it("refreshes separate single and batch cards from their own start times", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const first = createComponent(definition, "subagent-live-first", {
			tasks: [{ agent: "explorer", prompt: "Inspect silently." }],
		});
		first.markExecutionStarted();
		first.updateResult(
			{ content: [{ type: "text", text: "running" }], details: runningDetails(0), isError: false },
			true,
		);

		vi.advanceTimersByTime(1000);
		const second = createComponent(definition, "subagent-live-second", {
			tasks: [
				{ agent: "explorer", prompt: "Inspect A." },
				{ agent: "general", prompt: "Inspect B." },
			],
		});
		second.markExecutionStarted();
		second.updateResult(
			{
				content: [{ type: "text", text: "running" }],
				details: runningDetails(1000, 2),
				isError: false,
			},
			true,
		);

		vi.advanceTimersByTime(2000);
		const single = render(first);
		expect(single).toContain("● Subagent");
		expect(single).toMatch(new RegExp(`${SPINNER_CLASS} #1 Explorer`, "u"));
		expect(single).not.toContain("3.0s");
		const batchCollapsed = render(second);
		expect(batchCollapsed).toContain("● Subagent");
		expect(batchCollapsed).toMatch(new RegExp(`${SPINNER_CLASS} #1 Explorer`, "u"));
		expect(batchCollapsed).toMatch(new RegExp(`${SPINNER_CLASS} #2 Explorer`, "u"));
		expect(batchCollapsed).not.toContain("Exploring code");
		expect(batchCollapsed).not.toContain("0/2 done");
		expect(batchCollapsed).not.toContain("Running…");

		second.setExpanded(true);
		const batchExpanded = render(second);
		expect(batchExpanded).toContain("── Batch · 2 tasks · 2.0s");
		expect(batchExpanded).not.toContain("Running…");
		first.dispose();
		second.dispose();
	});
});
