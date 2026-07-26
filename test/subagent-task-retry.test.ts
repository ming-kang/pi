import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import type { SdkRunnerOptions } from "../src/extensions/subagent/sdk-runner.ts";
import { runSdkTask } from "../src/extensions/subagent/sdk-runner.ts";
import type { AgentDefinition } from "../src/extensions/subagent/types.ts";

vi.mock("../src/extensions/subagent/sdk-runner.ts", () => ({
	runSdkTask: vi.fn(),
}));

const runSdkTaskMock = vi.mocked(runSdkTask);

const agent: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	tools: ["read"],
	systemPrompt: "Return a concise result.",
	source: "user",
	filePath: "worker.md",
	backend: "sdk",
};

function model(): Model<Api> {
	return {
		id: "m",
		name: "m",
		api: "test-api" as Api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	} as Model<Api>;
}

function parentContext(parentModel: Model<Api>): ParentModelContext {
	return {
		model: parentModel,
		thinking: "medium",
		modelRegistry: {
			find: () => parentModel,
			getAvailable: () => [parentModel],
			hasConfiguredAuth: () => true,
		},
	};
}

function failWith(error: string): (options: SdkRunnerOptions) => Promise<SdkRunnerOptions["run"]> {
	return async (options) => {
		options.run.status = "failed";
		options.run.error = error;
		options.run.endedAt = Date.now();
		return options.run;
	};
}

function succeedWith(output: string): (options: SdkRunnerOptions) => Promise<SdkRunnerOptions["run"]> {
	return async (options) => {
		options.run.status = "completed";
		options.run.finalOutput = output;
		options.run.usage.turns = 1;
		options.run.endedAt = Date.now();
		return options.run;
	};
}

function invoke(signal?: AbortSignal) {
	return runSubagentInvocation({
		params: { agent: "worker", description: "Run worker", prompt: "Do the task." },
		parentCwd: process.cwd(),
		agents: [agent],
		parent: parentContext(model()),
		modelRuntime: {} as ModelRuntime,
		agentDir: process.cwd(),
		projectTrusted: false,
		signal,
		gate: new ConcurrencyGate(1),
		taskRetryBaseDelayMs: 1,
	});
}

describe("subagent task-level retry", () => {
	beforeEach(() => {
		runSdkTaskMock.mockReset();
	});

	it("retries a produced-nothing failure with a retryable error and then succeeds", async () => {
		runSdkTaskMock.mockImplementationOnce(failWith("fetch failed")).mockImplementationOnce(succeedWith("recovered"));
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(2);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("recovered");
	});

	it("stops after the retry budget is exhausted", async () => {
		runSdkTaskMock.mockImplementation(failWith("socket hang up"));
		const result = await invoke();
		// Initial attempt plus TASK_RETRY_LIMIT retries.
		expect(runSdkTaskMock).toHaveBeenCalledTimes(3);
		expect(result.isError).toBe(true);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("does not retry non-retryable errors", async () => {
		runSdkTaskMock.mockImplementation(failWith("insufficient_quota: billing hard limit reached"));
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
	});

	it("does not retry once the run has produced work", async () => {
		runSdkTaskMock.mockImplementation(async (options) => {
			options.run.status = "failed";
			options.run.error = "fetch failed";
			// Session-level auto-retry already owned this failure: the run has
			// real turns behind it, so a task-level rerun would discard work.
			options.run.usage.turns = 2;
			options.run.endedAt = Date.now();
			return options.run;
		});
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
	});
});
