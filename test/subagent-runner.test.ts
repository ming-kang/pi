import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, runSubagentInvocation, statusSummary } from "../src/extensions/subagent/runner.ts";
import type { SubagentParams } from "../src/extensions/subagent/schema.ts";
import type { AgentDefinition, SubagentDetails } from "../src/extensions/subagent/types.ts";

const agent: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	tools: ["read"],
	systemPrompt: "Return a concise result.",
	source: "user",
	filePath: "worker.md",
	backend: "sdk",
};

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

	it("runs a single isolated SDK session and reports progress and usage", async () => {
		const { modelRuntime, model } = await setup(["single result"]);
		const updates: string[] = [];
		const params: SubagentParams = {
			agent: "worker",
			description: "Run one worker",
			prompt: "Return the result.",
		};
		const result = await runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
			onUpdate: (details) => updates.push(details.status),
		});
		expect(result.isError).toBe(false);
		expect(result.content).toBe("single result");
		expect(result.details.status).toBe("completed");
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
		await runSubagentInvocation({
			params: { agent: "worker", description: "Inspect worker prompt", prompt: "Check the prompt." },
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		});

		expect(settingsCreate).toHaveBeenCalledWith(process.cwd(), process.cwd(), { projectTrusted: false });
		expect(systemPrompt).toContain("do not gold-plate it, but do not leave it half-done");
		expect(systemPrompt).toContain("use absolute paths");
		expect(systemPrompt).toContain("Only your final message is returned to the caller");
		expect(systemPrompt).toContain("code snippets only when the exact text is load-bearing");
		expect(systemPrompt).toContain("The caller will relay it to the user");
		expect(systemPrompt).toContain(agent.systemPrompt);
		// Default agents load project instructions (this repo has AGENTS.md).
		expect(systemPrompt).toContain("<project_context>");
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
		await runSubagentInvocation({
			params: { agent: "scout", description: "Inspect context loading", prompt: "Check the prompt." },
			parentCwd: process.cwd(),
			agents: [{ ...agent, name: "scout", omitContextFiles: true }],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		});

		expect(systemPrompt).toContain(agent.systemPrompt);
		expect(systemPrompt).not.toContain("<project_context>");
	});

	it("returns an explicit marker when a completed subagent has no output", async () => {
		const { modelRuntime, model } = await setup([""]);
		const result = await runSubagentInvocation({
			params: { agent: "worker", description: "Run empty worker", prompt: "Return nothing." },
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		});
		expect(result.isError).toBe(false);
		expect(result.content).toBe("(Subagent completed but returned no output.)");
	});

	it("runs parallel tasks and labels each section with description and agent", async () => {
		const { modelRuntime, model } = await setup(["first result", "second result"]);
		const params: SubagentParams = {
			tasks: [
				{ agent: "worker", description: "First lookup", prompt: "Find the answer." },
				{ agent: "worker", description: "Second lookup", prompt: "Find the other answer." },
			],
		};
		const result = await runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		});
		expect(result.details.status).toBe("completed");
		expect(result.details.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
		expect(result.content).toContain("### First lookup (worker) — completed");
		expect(result.content).toContain("### Second lookup (worker) — completed");
	});

	it("accepts null mode fields from strict providers that send every property", async () => {
		const { modelRuntime, model } = await setup(["task result"]);
		const params: SubagentParams = {
			agent: null,
			description: null,
			prompt: null,
			cwd: null,
			tasks: [{ agent: "worker", description: "Only task", prompt: "Do it.", cwd: null }],
		};
		const result = await runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		});
		expect(result.isError).toBe(false);
		expect(result.details.status).toBe("completed");
		expect(result.content).toContain("task result");
	});

	it("names the received modes when the call is ambiguous", async () => {
		const { modelRuntime, model } = await setup([]);
		const base = {
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			gate: new ConcurrencyGate(1),
		};
		const ambiguous: SubagentParams = {
			description: "Everything at once",
			prompt: "unused",
			tasks: [{ description: "task", prompt: "p" }],
		};
		await expect(runSubagentInvocation({ ...base, params: ambiguous })).rejects.toThrow("received prompt, tasks");
		const empty: SubagentParams = { agent: null, description: null, prompt: null, tasks: null };
		await expect(runSubagentInvocation({ ...base, params: empty })).rejects.toThrow("none was provided");
	});

	it("uses Initializing… only after a single run begins starting", () => {
		const details: SubagentDetails = {
			mode: "single",
			status: "running",
			startedAt: 0,
			usage: { turns: 0, toolUses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			runs: [
				{
					id: "subagent-1",
					agent: "worker",
					agentSource: "builtin",
					description: "Initialize worker",
					prompt: "Start the task.",
					cwd: process.cwd(),
					model: "test/model",
					thinking: "medium",
					status: "running",
					activities: [],
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
				},
			],
		};
		expect(statusSummary(details)).toBe("Initializing…");
		expect(statusSummary({ ...details, runs: [{ ...details.runs[0]!, status: "queued" }] })).toBe("queued");
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
