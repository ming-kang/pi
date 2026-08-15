import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { emptyUsage } from "../src/extensions/subagent/activity.ts";
import { AGENT_PROFILES } from "../src/extensions/subagent/agents.ts";
import { MAX_CONCURRENCY, MAX_TASKS } from "../src/extensions/subagent/constants.ts";
import { type ParentModelContext, resolveSubagentTask } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, isSubagentError, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import { type SubagentParams, SubagentParamsSchema } from "../src/extensions/subagent/schema.ts";
import { emptySubagentConfig } from "../src/extensions/subagent/settings.ts";
import { createRunState, reduceRun, statusSummary, versionSum } from "../src/extensions/subagent/state.ts";
import type {
	SubagentDetails,
	SubagentRunDetails,
	SubagentRunStatus,
	ToolActivity,
} from "../src/extensions/subagent/types.ts";

const validateParams = Compile(SubagentParamsSchema);

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

function baseRun(status: SubagentRunStatus, activities: ToolActivity[] = []): SubagentRunDetails {
	return {
		id: "subagent-1",
		agent: "explorer",
		description: "Task",
		cwd: "",
		model: "test/model",
		thinking: "low",
		status,
		activities,
		report: "",
		usage: emptyUsage(),
	};
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

	it("enforces tasks-only parameters and explorer/general agents at the schema level", () => {
		expect(validateParams.Check({ tasks: [{ prompt: "Find it." }] })).toBe(true);
		expect(validateParams.Check({ tasks: [{ agent: null, prompt: "Find it.", cwd: null }] })).toBe(true);
		expect(validateParams.Check({ tasks: [{ agent: "explorer", prompt: "Find it." }] })).toBe(true);
		expect(validateParams.Check({ tasks: [{ agent: "general", prompt: "Fix it." }] })).toBe(true);
		// Top-level mode fields are gone: only `tasks` is accepted.
		expect(validateParams.Check({ agent: "explorer", tasks: [{ prompt: "Find it." }] })).toBe(false);
		expect(validateParams.Check({ tasks: [] })).toBe(false);
		// Task items carry only agent/prompt/cwd; descriptions are derived from the prompt.
		expect(validateParams.Check({ tasks: [{ description: "Lookup", prompt: "Find it." }] })).toBe(false);
		// Only the two built-in profiles are selectable.
		expect(validateParams.Check({ tasks: [{ agent: "worker", prompt: "Find it." }] })).toBe(false);
	});

	it("defaults an omitted agent to explorer and rejects unknown agents during resolution", async () => {
		const parent = createParentContext(minimalModel());
		const resolved = await resolveSubagentTask(
			{ prompt: "Look something up." },
			process.cwd(),
			parent,
			process.cwd(),
			emptySubagentConfig(),
		);
		expect(resolved.agent.name).toBe("explorer");
		expect(resolved.description).toBe("Look something up.");

		const general = await resolveSubagentTask(
			{ agent: "general", prompt: "Fix something." },
			process.cwd(),
			parent,
			process.cwd(),
			emptySubagentConfig(),
		);
		expect(general.agent.name).toBe("general");

		await expect(
			resolveSubagentTask(
				{ agent: "worker", prompt: "x" } as unknown as SubagentParams["tasks"][number],
				process.cwd(),
				parent,
				process.cwd(),
				emptySubagentConfig(),
			),
		).rejects.toThrow("Unknown agent");
	});

	it("uses Initializing… only while no run exists yet", () => {
		const details: SubagentDetails = { status: "running", runs: [], startedAt: 0, usage: emptyUsage() };
		expect(statusSummary(details)).toBe("Initializing…");
		const queued = { ...details, runs: [baseRun("queued")] };
		expect(statusSummary(queued)).toBe("0/1 complete · 1 queued");
		const mixed = {
			...details,
			runs: [baseRun("completed"), baseRun("running"), baseRun("failed"), baseRun("aborted")],
		};
		expect(statusSummary(mixed)).toBe("1/4 complete · 1 running · 1 failed · 1 aborted");
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

	it("detects mid-list activity changes from out-of-order tool ends", () => {
		// Tool B settles before tool A: the last activity is unchanged, but
		// the settled row is mid-list and the run revision must still move so
		// the progress detector emits an update.
		const resolved = {
			agent: {
				name: "explorer" as const,
				description: "",
				tools: ["read"],
				systemPrompt: "",
				omitContextFiles: true,
			},
			description: "Task",
			prompt: "Task",
			cwd: process.cwd(),
			model: minimalModel(),
			thinking: "low" as const,
		};
		let run = createRunState(resolved, 0, undefined, process.cwd());
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, { type: "tool_started", toolCallId: "a", toolName: "read", args: {}, startedAt: 0 });
		run = reduceRun(run, { type: "tool_started", toolCallId: "b", toolName: "read", args: {}, startedAt: 0 });
		const before = versionSum([run]);
		run = reduceRun(run, {
			type: "tool_ended",
			toolCallId: "b",
			result: { content: [] },
			isError: false,
			endedAt: 1,
		});
		expect(versionSum([run])).toBeGreaterThan(before);
		// The derived line falls back to the still-running tool A.
		expect(run.currentActivity).toBe("read");
	});

	it("classifies full failures as errors but partial batches as results", () => {
		expect(isSubagentError({ status: "failed", runs: [baseRun("failed")] })).toBe(true);
		expect(isSubagentError({ status: "failed", runs: [baseRun("completed"), baseRun("failed")] })).toBe(false);
		expect(isSubagentError({ status: "aborted", runs: [baseRun("aborted")] })).toBe(true);
		expect(isSubagentError({ status: "completed", runs: [baseRun("completed")] })).toBe(false);
	});
});
