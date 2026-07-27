import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import type { SubagentParamsSchema } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails, SubagentRunDetails } from "../src/extensions/subagent/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

function runningRun(id: string, startedAt: number): SubagentRunDetails {
	return {
		id,
		agent: "explorer",
		agentSource: "builtin",
		description: `Inspect ${id}`,
		prompt: "Inspect the code without producing output yet.",
		cwd: process.cwd(),
		model: "test/model",
		thinking: "low",
		status: "running",
		startedAt,
		currentActivity: "Exploring code",
		activities: [],
		liveText: "Waiting for the next finding",
		finalOutput: "",
		usage: usage(),
	};
}

function runningDetails(mode: "single" | "parallel", startedAt: number, runCount = 1): SubagentDetails {
	const runs = Array.from({ length: runCount }, (_, index) => runningRun(`run-${index + 1}`, startedAt));
	return {
		mode,
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
	run.liveText = "";
	run.finalOutput = "Completed report.";
	return {
		mode: "single",
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

	it("refreshes silent collapsed and expanded elapsed time without generic progress", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		expect(definition.rendersOwnProgress).toBe(true);
		expect(definition.renderRefreshIntervalMs).toBe(1000);
		const requestRender = vi.fn();
		const component = createComponent(
			definition,
			"subagent-live-single",
			{
				agent: "explorer",
				description: "Inspect single",
				prompt: "Inspect silently.",
			},
			requestRender,
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "running" }], details: runningDetails("single", 0), isError: false },
			true,
		);

		expect(render(component)).toContain("0.0s");
		vi.advanceTimersByTime(3000);
		const collapsed = render(component);
		expect(collapsed).toContain("3.0s");
		expect(collapsed).not.toContain("Running…");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("3.0s");
		expect(expanded).not.toContain("Running…");

		component.updateResult(
			{
				content: [{ type: "text", text: "Completed report." }],
				details: completedDetails(0, 3000),
				isError: false,
			},
			false,
		);
		const settled = render(component);
		const settledRenderRequests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(5000);
		expect(render(component)).toBe(settled);
		expect(requestRender).toHaveBeenCalledTimes(settledRenderRequests);
		component.dispose();
	});

	it("refreshes separate single and parallel cards from their own start times", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const definition = registeredSubagentTool();
		const first = createComponent(definition, "subagent-live-first", {
			agent: "explorer",
			description: "Inspect first",
			prompt: "Inspect silently.",
		});
		first.markExecutionStarted();
		first.updateResult(
			{ content: [{ type: "text", text: "running" }], details: runningDetails("single", 0), isError: false },
			true,
		);

		vi.advanceTimersByTime(1000);
		const second = createComponent(definition, "subagent-live-second", {
			tasks: [
				{ agent: "explorer", description: "Inspect A", prompt: "Inspect A." },
				{ agent: "explorer", description: "Inspect B", prompt: "Inspect B." },
			],
		});
		second.markExecutionStarted();
		second.updateResult(
			{
				content: [{ type: "text", text: "running" }],
				details: runningDetails("parallel", 1000, 2),
				isError: false,
			},
			true,
		);

		vi.advanceTimersByTime(2000);
		expect(render(first)).toContain("3.0s");
		const parallelCollapsed = render(second);
		expect(parallelCollapsed).toContain("2.0s");
		expect(parallelCollapsed).toContain("2 running");
		expect(parallelCollapsed).not.toContain("Running…");

		second.setExpanded(true);
		const parallelExpanded = render(second);
		expect(parallelExpanded).toContain("2.0s");
		expect(parallelExpanded).not.toContain("Running…");
		first.dispose();
		second.dispose();
	});
});
