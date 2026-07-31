import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import type { SdkRunnerOptions } from "../src/extensions/subagent/sdk-runner.ts";
import { runSdkTask } from "../src/extensions/subagent/sdk-runner.ts";
import type { AgentDefinition, SubagentDetails } from "../src/extensions/subagent/types.ts";

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

interface InvokeOptions {
	signal?: AbortSignal;
	taskRetryBaseDelayMs?: number;
	onUpdate?: (details: SubagentDetails) => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
}

function invoke(options: InvokeOptions = {}) {
	return runSubagentInvocation({
		params: { agent: "worker", description: "Run worker", prompt: "Do the task." },
		parentCwd: process.cwd(),
		agents: [agent],
		parent: parentContext(model()),
		modelRuntime: {} as ModelRuntime,
		agentDir: process.cwd(),
		projectTrusted: false,
		signal: options.signal,
		gate: new ConcurrencyGate(1),
		taskRetryBaseDelayMs: options.taskRetryBaseDelayMs ?? 1,
		onUpdate: options.onUpdate,
		registerAbort: options.registerAbort,
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
		expect(result.content).toBe("recovered");
	});

	it("emits bounded task retry deadlines and removes them from the final result", async () => {
		const updates: SubagentDetails[] = [];
		runSdkTaskMock
			.mockImplementationOnce(failWith(`fetch failed ${"x".repeat(500)}`))
			.mockImplementationOnce(succeedWith("recovered"));
		const result = await invoke({ onUpdate: (details) => updates.push(details), taskRetryBaseDelayMs: 5 });
		const retryUpdate = updates.find((details) => details.runs[0]?.retry);
		const retry = retryUpdate?.runs[0]?.retry;
		expect(retry).toMatchObject({ attempt: 1, maxAttempts: 2 });
		expect(retry?.deadline).toBeGreaterThan(0);
		expect(Buffer.byteLength(retry?.error ?? "", "utf8")).toBeLessThanOrEqual(160);
		expect(retryUpdate?.runs[0]?.currentActivity).toBe("Retrying (1/2)…");
		expect(result.details.runs[0]?.retry).toBeUndefined();
		expect(result.details.runs[0]?.currentActivity).toBeUndefined();
	});

	it("clears task retry state when aborted during backoff", async () => {
		const controller = new AbortController();
		runSdkTaskMock.mockImplementation(failWith("fetch failed"));
		const result = await invoke({
			signal: controller.signal,
			taskRetryBaseDelayMs: 8000,
			onUpdate: (details) => {
				if (details.runs[0]?.retry) controller.abort();
			},
		});
		expect(result.details.runs[0]?.status).toBe("aborted");
		expect(result.details.runs[0]?.retry).toBeUndefined();
		expect(result.details.runs[0]?.currentActivity).toBeUndefined();
	});

	it("clears task retry state when session shutdown aborts the backoff", async () => {
		let registeredAbort: (() => Promise<void>) | undefined;
		const unregisterAbort = vi.fn();
		runSdkTaskMock.mockImplementation(failWith("fetch failed"));
		const result = await invoke({
			taskRetryBaseDelayMs: 8000,
			registerAbort: (abort) => {
				registeredAbort = abort;
				return unregisterAbort;
			},
			onUpdate: (details) => {
				if (!details.runs[0]?.retry) return;
				queueMicrotask(() => {
					void registeredAbort?.();
				});
			},
		});
		expect(registeredAbort).toBeDefined();
		expect(unregisterAbort).toHaveBeenCalledTimes(1);
		expect(result.details.runs[0]?.status).toBe("aborted");
		expect(result.details.runs[0]?.retry).toBeUndefined();
		expect(result.details.runs[0]?.currentActivity).toBeUndefined();
	});

	it("stops after the retry budget is exhausted", async () => {
		runSdkTaskMock.mockImplementation(failWith("socket hang up"));
		const result = await invoke();
		// Initial attempt plus TASK_RETRY_LIMIT retries.
		expect(runSdkTaskMock).toHaveBeenCalledTimes(3);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("does not retry non-retryable errors", async () => {
		runSdkTaskMock.mockImplementation(failWith("insufficient_quota: billing hard limit reached"));
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("does not mark a parallel batch as an error while any task succeeded", async () => {
		runSdkTaskMock
			.mockImplementationOnce(succeedWith("good result"))
			.mockImplementationOnce(failWith("insufficient_quota: billing hard limit reached"));
		const result = await runSubagentInvocation({
			params: {
				tasks: [
					{ agent: "worker", description: "First task", prompt: "Do the first." },
					{ agent: "worker", description: "Second task", prompt: "Do the second." },
				],
			},
			parentCwd: process.cwd(),
			agents: [agent],
			parent: parentContext(model()),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
			taskRetryBaseDelayMs: 1,
		});
		expect(result.details.status).toBe("failed");
		expect(result.content).toContain("good result");
		expect(result.content).toContain("insufficient_quota");
	});

	it("marks a parallel batch as an error when every task failed", async () => {
		runSdkTaskMock.mockImplementation(failWith("insufficient_quota: billing hard limit reached"));
		const result = await runSubagentInvocation({
			params: {
				tasks: [
					{ agent: "worker", description: "First task", prompt: "Do the first." },
					{ agent: "worker", description: "Second task", prompt: "Do the second." },
				],
			},
			parentCwd: process.cwd(),
			agents: [agent],
			parent: parentContext(model()),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
			taskRetryBaseDelayMs: 1,
		});
		expect(result.details.status).toBe("failed");
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
		expect(result.details.runs[0]?.status).toBe("failed");
	});
});
