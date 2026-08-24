import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { AGENT_PROFILES } from "../src/extensions/subagent/agents.ts";
import { MAX_CONCURRENCY, MAX_TASKS } from "../src/extensions/subagent/constants.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import type { SubagentParams } from "../src/extensions/subagent/schema.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

function createParentContext(model: Model<Api>): ParentModelContext {
	return {
		model,
		thinking: "medium",
		modelRegistry: {
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
		},
	};
}

function minimalModel(): Model<Api> {
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

describe("subagent SDK runner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function setup(responses: string[]) {
		const faux = fauxProvider({ provider: `subagent-runner-${Date.now()}-${Math.random()}` });
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		return { modelRuntime, model: faux.getModel() as Model<Api> };
	}

	async function run(
		params: SubagentParams,
		modelRuntime: ModelRuntime,
		model: Model<Api>,
		gate = new ConcurrencyGate(1),
		onUpdate?: (details: SubagentDetails) => void,
	) {
		return runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate,
			onUpdate,
		});
	}

	it("runs a single isolated SDK session and reports progress and usage", async () => {
		const { modelRuntime, model } = await setup(["single result"]);
		const updates: string[] = [];
		const result = await run(
			{ tasks: [{ prompt: "Return the result." }] },
			modelRuntime,
			model,
			new ConcurrencyGate(1),
			(details) => updates.push(details.status),
		);
		expect(result.content).toContain("single result");
		expect(result.details.status).toBe("completed");
		expect(result.details.runs).toHaveLength(1);
		expect(result.details.runs[0]?.usage.totalTokens).toBeGreaterThan(0);
		expect(updates).toContain("running");
		expect(updates.at(-1)).toBe("completed");
	});

	it("builds a self-contained worker system prompt with completion and relay guidance", async () => {
		const settingsCreate = vi.spyOn(SettingsManager, "create");
		let systemPrompt: string | undefined;
		const faux = fauxProvider({ provider: `subagent-prompt-${Date.now()}-${Math.random()}` });
		faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt;
				return fauxAssistantMessage("prompt checked");
			},
		]);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		await run({ tasks: [{ agent: "general", prompt: "Check the prompt." }] }, modelRuntime, model);

		expect(settingsCreate).toHaveBeenCalledWith(process.cwd(), process.cwd(), { projectTrusted: false });
		expect(systemPrompt).toContain("do not gold-plate it, but do not leave it half-done");
		expect(systemPrompt).toContain("use paths relative to the task's working directory");
		expect(systemPrompt).toContain("Only your final message is returned to the caller");
		expect(systemPrompt).toContain("code snippets only when the exact text is load-bearing");
		expect(systemPrompt).toContain("The caller will relay it to the user");
		// The general profile loads project instructions (this repo has AGENTS.md).
		expect(systemPrompt).toContain("<project_context>");
		const general = AGENT_PROFILES.find((profile) => profile.name === "general")!;
		expect(systemPrompt).toContain(general.systemPrompt);
	});

	it("skips project instruction files for agents marked omitContextFiles", async () => {
		let systemPrompt: string | undefined;
		const faux = fauxProvider({ provider: `subagent-context-${Date.now()}-${Math.random()}` });
		faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt;
				return fauxAssistantMessage("context checked");
			},
		]);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		await run({ tasks: [{ agent: "explorer", prompt: "Check the context." }] }, modelRuntime, model);

		const explorer = AGENT_PROFILES.find((profile) => profile.name === "explorer")!;
		expect(systemPrompt).toContain(explorer.systemPrompt);
		expect(systemPrompt).not.toContain("<project_context>");
	});

	it("returns an explicit marker when a completed subagent has no output", async () => {
		const { modelRuntime, model } = await setup([""]);
		const result = await run({ tasks: [{ prompt: "Return nothing." }] }, modelRuntime, model);
		expect(result.content).toContain("(Subagent completed but returned no output.)");
		expect(result.details.status).toBe("completed");
	});

	it("runs parallel tasks and labels each section with description and agent", async () => {
		const { modelRuntime, model } = await setup(["first result", "second result"]);
		const result = await run(
			{
				tasks: [
					{ prompt: "## **First lookup**\nFind the answer." },
					{ prompt: "Second lookup\nFind the other answer." },
				],
			},
			modelRuntime,
			model,
		);
		expect(result.details.status).toBe("completed");
		expect(result.details.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
		expect(result.details.runs.map((run) => run.agent)).toEqual(["explorer", "explorer"]);
		expect(result.details.runs.map((run) => run.description)).toEqual(["First lookup", "Second lookup"]);
		expect(result.content).toContain("### 1. First lookup (explorer) — completed");
		expect(result.content).toContain("### 2. Second lookup (explorer) — completed");
		expect(result.content).not.toContain("### 1. ##");
		// Sections stay in input order.
		expect(result.content.indexOf("### 1.")).toBeLessThan(result.content.indexOf("### 2."));
	});

	it("accepts null agent and cwd fields from strict providers that send every property", async () => {
		const { modelRuntime, model } = await setup(["task result"]);
		const result = await run({ tasks: [{ agent: null, prompt: "Do it.", cwd: null }] }, modelRuntime, model);
		expect(result.details.status).toBe("completed");
		expect(result.content).toContain("task result");
	});

	it("rejects an empty task list and over-limit task lists before any work starts", async () => {
		const modelRuntime = {} as ModelRuntime;
		const model = minimalModel();
		await expect(run({} as SubagentParams, modelRuntime, model)).rejects.toThrow(
			"Subagent task list must not be empty.",
		);
		const tooMany = Array.from({ length: MAX_TASKS + 1 }, (_, index) => ({ prompt: `Task ${index}` }));
		await expect(run({ tasks: tooMany }, modelRuntime, model)).rejects.toThrow(
			`Subagent task list is limited to ${MAX_TASKS} tasks.`,
		);
	});

	it("limits concurrent workers to the gate's configured concurrency", async () => {
		const gate = new ConcurrencyGate(2);
		const first = await gate.acquire();
		const second = await gate.acquire();
		let thirdResolved = false;
		const third = gate.acquire().then((release) => {
			thirdResolved = true;
			return release;
		});
		expect(thirdResolved).toBe(false);
		second();
		await third;
		expect(thirdResolved).toBe(true);
		first();
	});

	it("defaults the gate to the global max concurrency", async () => {
		const gate = new ConcurrencyGate();
		const releases: Array<() => void> = [];
		for (let index = 0; index < MAX_CONCURRENCY; index++) releases.push(await gate.acquire());
		let extraResolved = false;
		const extra = gate.acquire().then((release) => {
			extraResolved = true;
			return release;
		});
		expect(extraResolved).toBe(false);
		releases[0]?.();
		await extra;
		expect(extraResolved).toBe(true);
		for (const release of releases.slice(1)) release();
	});

	it("does not start queued work after the parent signal aborts", async () => {
		const gate = new ConcurrencyGate(1);
		const release = await gate.acquire();
		const controller = new AbortController();
		const queued = gate.acquire(controller.signal);
		controller.abort();
		await expect(queued).rejects.toThrow("queued");
		release();
	});
});
