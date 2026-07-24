import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ParentModelContext } from "../src/extensions/subagent/resolve.ts";
import { ConcurrencyGate, runSubagentInvocation } from "../src/extensions/subagent/runner.ts";
import type { SubagentParams } from "../src/extensions/subagent/schema.ts";
import type { AgentDefinition } from "../src/extensions/subagent/types.ts";

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
			configAgentDir: process.cwd(),
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

	it("executes chain steps sequentially and passes bounded previous output", async () => {
		const { modelRuntime, model } = await setup(["first result", "second result"]);
		const params: SubagentParams = {
			chain: [
				{ agent: "worker", description: "First", prompt: "Find the answer." },
				{ agent: "worker", description: "Second", prompt: "Use this report:\n{previous}" },
			],
		};
		const result = await runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			configAgentDir: process.cwd(),
			gate: new ConcurrencyGate(1),
		});
		expect(result.details.status).toBe("completed");
		expect(result.content).toBe("second result");
		expect(result.details.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
	});

	it("accepts null mode fields from strict providers that send every property", async () => {
		const { modelRuntime, model } = await setup(["chain result"]);
		const params: SubagentParams = {
			agent: null,
			description: null,
			prompt: null,
			cwd: null,
			tasks: null,
			chain: [{ agent: "worker", description: "Only step", prompt: "Do it.", cwd: null }],
		};
		const result = await runSubagentInvocation({
			params,
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			configAgentDir: process.cwd(),
			gate: new ConcurrencyGate(1),
		});
		expect(result.isError).toBe(false);
		expect(result.details.status).toBe("completed");
		expect(result.content).toBe("chain result");
	});

	it("names the received modes when the call is ambiguous", async () => {
		const { modelRuntime, model } = await setup([]);
		const base = {
			parentCwd: process.cwd(),
			agents: [agent],
			parent: createParentContext(model),
			modelRuntime,
			agentDir: process.cwd(),
			configAgentDir: process.cwd(),
			gate: new ConcurrencyGate(1),
		};
		const ambiguous: SubagentParams = {
			description: "Everything at once",
			prompt: "unused",
			tasks: [{ description: "task", prompt: "p" }],
			chain: [{ description: "step", prompt: "p" }],
		};
		await expect(runSubagentInvocation({ ...base, params: ambiguous })).rejects.toThrow(
			"received prompt, tasks, chain",
		);
		const empty: SubagentParams = { agent: null, description: null, prompt: null, tasks: null, chain: null };
		await expect(runSubagentInvocation({ ...base, params: empty })).rejects.toThrow("none was provided");
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
