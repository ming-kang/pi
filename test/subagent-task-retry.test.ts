import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { DETAILS_OUTPUT_LIMIT, TASK_OUTPUT_LIMIT, TOTAL_OUTPUT_LIMIT } from "../src/extensions/subagent/constants.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, isSubagentError, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import { runSdkTask, type SdkRunnerOptions } from "../src/extensions/subagent/sdk-runner.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

vi.mock("../src/extensions/subagent/sdk-runner.ts", () => ({
	runSdkTask: vi.fn(),
}));

const runSdkTaskMock = vi.mocked(runSdkTask);

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

async function failRun(options: SdkRunnerOptions, error: string): Promise<void> {
	options.dispatch({ type: "settle", verdict: "failed", report: "", error, endedAt: Date.now() });
	options.onProgress?.();
}

async function succeedRun(options: SdkRunnerOptions, output: string): Promise<void> {
	options.dispatch({ type: "turn_end" });
	options.dispatch({ type: "settle", verdict: "completed", report: output, error: undefined, endedAt: Date.now() });
	options.onProgress?.();
}

interface InvokeOptions {
	signal?: AbortSignal;
	taskRetryBaseDelayMs?: number;
	onUpdate?: (details: SubagentDetails) => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
}

function invoke(options: InvokeOptions = {}) {
	return runSubagentInvocation({
		params: { tasks: [{ prompt: "Do the task." }] },
		parentCwd: process.cwd(),
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

function invokeTasks(prompts: string[], gate = new ConcurrencyGate(1), options: InvokeOptions = {}) {
	return runSubagentInvocation({
		params: { tasks: prompts.map((prompt) => ({ prompt })) },
		parentCwd: process.cwd(),
		parent: parentContext(model()),
		modelRuntime: {} as ModelRuntime,
		agentDir: process.cwd(),
		projectTrusted: false,
		gate,
		taskRetryBaseDelayMs: 1,
		...options,
	});
}

describe("subagent task-level retry", () => {
	beforeEach(() => {
		runSdkTaskMock.mockReset();
	});

	it("retries a produced-nothing failure with a retryable error and then succeeds", async () => {
		runSdkTaskMock
			.mockImplementationOnce((options) => failRun(options, "fetch failed"))
			.mockImplementationOnce((options) => succeedRun(options, "recovered"));
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(2);
		expect(result.content).toContain("recovered");
	});

	it("emits bounded task retry deadlines and removes them from the final result", async () => {
		const updates: SubagentDetails[] = [];
		runSdkTaskMock
			.mockImplementationOnce((options) => failRun(options, `fetch failed ${"x".repeat(500)}`))
			.mockImplementationOnce((options) => succeedRun(options, "recovered"));
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

	it("emits progress when only cost or context usage changes mid-run", async () => {
		// Regression: the historical string progress key omitted usage cost
		// and the context watermark, swallowing these updates.
		const updates: SubagentDetails[] = [];
		runSdkTaskMock.mockImplementation(async (options) => {
			options.dispatch({
				type: "assistant_message_settled",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				},
			});
			options.onProgress?.();
			options.dispatch({
				type: "assistant_message_settled",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.15 },
				},
			});
			options.onProgress?.();
			await succeedRun(options, "done");
		});
		await invoke({ onUpdate: (details) => updates.push(details) });
		const costs = updates.map((details) => details.usage.cost);
		expect(costs.length).toBeGreaterThanOrEqual(2);
		expect(costs.at(-1)).toBeCloseTo(0.15 + 0.03);
	});

	it("clears task retry state when aborted during backoff", async () => {
		const controller = new AbortController();
		runSdkTaskMock.mockImplementation((options) => failRun(options, "fetch failed"));
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
		runSdkTaskMock.mockImplementation((options) => failRun(options, "fetch failed"));
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
		runSdkTaskMock.mockImplementation((options) => failRun(options, "socket hang up"));
		const result = await invoke();
		// Initial attempt plus TASK_RETRY_LIMIT retries.
		expect(runSdkTaskMock).toHaveBeenCalledTimes(3);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("does not retry non-retryable errors", async () => {
		runSdkTaskMock.mockImplementation((options) =>
			failRun(options, "insufficient_quota: billing hard limit reached"),
		);
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("does not retry once the run has produced work", async () => {
		runSdkTaskMock.mockImplementation(async (options) => {
			// Session-level auto-retry already owned this failure: the run has
			// real turns behind it, so a task-level rerun would discard work.
			options.dispatch({ type: "turn_end" });
			options.dispatch({ type: "turn_end" });
			await failRun(options, "fetch failed");
		});
		const result = await invoke();
		expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
		expect(result.details.runs[0]?.status).toBe("failed");
	});

	it("reports partial when any task succeeded but others failed, and never treats the batch as an error", async () => {
		runSdkTaskMock
			.mockImplementationOnce((options) => succeedRun(options, "good result"))
			.mockImplementationOnce((options) => failRun(options, "insufficient_quota: billing hard limit reached"));
		const result = await invokeTasks(["First task\nDo the first.", "Second task\nDo the second."]);
		expect(result.details.status).toBe("partial");
		expect(isSubagentError(result.details)).toBe(false);
		expect(result.content).toContain("good result");
		expect(result.content).toContain("insufficient_quota");
	});

	it("marks a parallel batch as an error when every task failed", async () => {
		runSdkTaskMock.mockImplementation((options) =>
			failRun(options, "insufficient_quota: billing hard limit reached"),
		);
		const result = await invokeTasks(["First task\nDo the first.", "Second task\nDo the second."]);
		expect(result.details.status).toBe("failed");
		expect(isSubagentError(result.details)).toBe(true);
	});

	it("reports aborted when every task aborted", async () => {
		runSdkTaskMock.mockImplementation(async (options) => {
			options.dispatch({
				type: "settle",
				verdict: "aborted",
				report: "",
				error: "Subagent was aborted.",
				endedAt: Date.now(),
			});
			options.onProgress?.();
		});
		const result = await invokeTasks(["First task\nDo the first.", "Second task\nDo the second."]);
		expect(result.details.status).toBe("aborted");
		expect(isSubagentError(result.details)).toBe(true);
	});

	it("resolves every task before any worker starts", async () => {
		runSdkTaskMock.mockImplementation(() => {
			throw new Error("runSdkTask must not run before every task resolves");
		});
		await expect(
			runSubagentInvocation({
				params: {
					tasks: [
						{ prompt: "First\nValid task." },
						{ prompt: "Second\nInvalid cwd.", cwd: "definitely-not-a-real-directory" },
					],
				},
				parentCwd: process.cwd(),
				parent: parentContext(model()),
				modelRuntime: {} as ModelRuntime,
				agentDir: process.cwd(),
				projectTrusted: false,
				gate: new ConcurrencyGate(1),
				taskRetryBaseDelayMs: 1,
			}),
		).rejects.toThrow("Subagent task tasks[1] failed to resolve");
		expect(runSdkTaskMock).not.toHaveBeenCalled();
	});

	it("runs queued tasks concurrently up to the configured gate limit and preserves input order", async () => {
		const started: string[] = [];
		let active = 0;
		let maxActive = 0;
		let releaseWorkers!: () => void;
		const workersReleased = new Promise<void>((resolve) => {
			releaseWorkers = resolve;
		});
		runSdkTaskMock.mockImplementation(async (options) => {
			active++;
			maxActive = Math.max(maxActive, active);
			started.push(options.task.description);
			await workersReleased;
			active--;
			await succeedRun(options, `result of ${options.task.description}`);
		});
		const resultPromise = invokeTasks(
			[
				"First task\nDo the first.",
				"Second task\nDo the second.",
				"Third task\nDo the third.",
				"Fourth task\nDo the fourth.",
			],
			new ConcurrencyGate(2),
		);
		// Exactly two workers start; the rest queue behind the gate.
		await vi.waitFor(() => expect(started).toHaveLength(2));
		expect(maxActive).toBe(2);
		releaseWorkers();
		const result = await resultPromise;
		expect(started).toHaveLength(4);
		expect(maxActive).toBeLessThanOrEqual(2);
		expect(result.details.status).toBe("completed");
		expect(result.details.runs.map((run) => run.description)).toEqual([
			"First task",
			"Second task",
			"Third task",
			"Fourth task",
		]);
		const titles = [...result.content.matchAll(/### (\d+)\./g)].map((match) => match[1]);
		expect(titles).toEqual(["1", "2", "3", "4"]);
	});

	it("keeps the batch running while any task is queued or running", async () => {
		const barriers: Array<() => void> = [];
		runSdkTaskMock.mockImplementation(async (options) => {
			options.onProgress?.();
			await new Promise<void>((resolve) => barriers.push(resolve));
			await succeedRun(options, `report ${options.task.description}`);
		});
		const updates: SubagentDetails[] = [];
		const resultPromise = runSubagentInvocation({
			params: {
				tasks: [
					{ prompt: "First task\nDo the first." },
					{ prompt: "Second task\nDo the second." },
					{ prompt: "Third task\nDo the third." },
				],
			},
			parentCwd: process.cwd(),
			parent: parentContext(model()),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
			taskRetryBaseDelayMs: 1,
			onUpdate: (details) => updates.push(details),
		});
		await vi.waitFor(() => expect(barriers).toHaveLength(1));
		// Active runs win over every terminal verdict: queued tasks keep the batch running.
		expect(
			updates.some((details) => details.status === "running" && details.runs.some((run) => run.status === "queued")),
		).toBe(true);
		barriers[0]?.();
		await vi.waitFor(() => expect(barriers).toHaveLength(2));
		expect(
			updates.some(
				(details) =>
					details.status === "running" &&
					details.runs.some((run) => run.status === "running") &&
					details.runs.some((run) => run.status === "completed"),
			),
		).toBe(true);
		barriers[1]?.();
		await vi.waitFor(() => expect(barriers).toHaveLength(3));
		barriers[2]?.();
		const result = await resultPromise;
		expect(result.details.status).toBe("completed");
	});

	it("aborts queued tasks when the parent signal fires while they wait for the gate", async () => {
		let releaseFirst!: () => void;
		runSdkTaskMock.mockImplementation(async (options) => {
			options.onProgress?.();
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			await succeedRun(options, `report ${options.task.description}`);
		});
		const controller = new AbortController();
		const resultPromise = runSubagentInvocation({
			params: {
				tasks: [{ prompt: "Slow task\nHolds the gate." }, { prompt: "Queued task\nWaits for the gate." }],
			},
			parentCwd: process.cwd(),
			parent: parentContext(model()),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			signal: controller.signal,
			gate: new ConcurrencyGate(1),
			taskRetryBaseDelayMs: 1,
		});
		await vi.waitFor(() => expect(runSdkTaskMock).toHaveBeenCalledTimes(1));
		controller.abort();
		releaseFirst();
		const result = await resultPromise;
		expect(result.details.runs[1]?.status).toBe("aborted");
		expect(result.details.runs[1]?.error).toContain("queued");
		expect(result.details.runs[0]?.status).toBe("completed");
		expect(result.details.status).toBe("partial");
	});

	it("releases the gate slot during retry backoff so queued tasks are not starved", async () => {
		const updates: SubagentDetails[] = [];
		const startOrder: string[] = [];
		let calls = 0;
		runSdkTaskMock.mockImplementation(async (options) => {
			startOrder.push(options.task.description);
			calls++;
			if (calls === 1) return failRun(options, "fetch failed");
			return succeedRun(options, `outcome ${calls}`);
		});
		const result = await runSubagentInvocation({
			params: {
				tasks: [{ prompt: "Flaky task\nRetry me." }, { prompt: "Fast task\nSucceed immediately." }],
			},
			parentCwd: process.cwd(),
			parent: parentContext(model()),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
			taskRetryBaseDelayMs: 200,
			onUpdate: (details) => updates.push(details),
		});
		expect(runSdkTaskMock).toHaveBeenCalledTimes(3);
		// The queued task ran between the flaky task's attempts: with a single
		// gate slot, that is only possible if backoff released the slot.
		expect(startOrder).toEqual(["Flaky task", "Fast task", "Flaky task"]);
		const duringBackoff = updates.find(
			(details) => details.runs[0]?.retry && details.runs[1]?.status === "completed",
		);
		expect(duringBackoff).toBeDefined();
		expect(result.content).toContain("outcome 2");
		expect(result.content).toContain("outcome 3");
		expect(result.details.runs[0]?.status).toBe("completed");
		expect(result.details.runs[1]?.status).toBe("completed");
	});

	it("bounds the aggregate report and details when every task produces oversized output", async () => {
		const oversized = "界".repeat(40_000);
		runSdkTaskMock.mockImplementation((options) => succeedRun(options, oversized));
		const result = await invokeTasks(
			[
				"First task\nDo the first.",
				"Second task\nDo the second.",
				"Third task\nDo the third.",
				"Fourth task\nDo the fourth.",
			],
			new ConcurrencyGate(2),
		);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(TOTAL_OUTPUT_LIMIT);
		expect(Buffer.byteLength(JSON.stringify(result.details), "utf8")).toBeLessThanOrEqual(DETAILS_OUTPUT_LIMIT);
		// Every section stays within its per-task budget.
		for (const section of result.content.split("\n\n---\n\n")) {
			expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(TASK_OUTPUT_LIMIT);
		}
		// The oversized reports were truncated, not echoed whole.
		expect(result.content).not.toContain(oversized);
		expect(result.details.runs[0]?.report.length).toBeLessThan(oversized.length);
	});

	it("reports worker output through the run's report field rather than live text or final output", async () => {
		runSdkTaskMock.mockImplementationOnce((options) => succeedRun(options, "recovered"));
		const result = await invoke();
		expect(result.details.runs[0]?.report).toBe("recovered");
		expect(result.details.runs[0]).not.toHaveProperty("liveText");
		expect(result.details.runs[0]).not.toHaveProperty("finalOutput");
		expect(result.details.usage.turns).toBe(1);
		expect(result.content).toContain("recovered");
	});
});
