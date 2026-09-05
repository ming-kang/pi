import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import { BackgroundService } from "../src/core/background/service.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import subagent from "../src/extensions/subagent/index.ts";
import { SubagentParamsSchema, TaskSchema } from "../src/extensions/subagent/schema.ts";
import type { SdkRunnerOptions } from "../src/extensions/subagent/sdk-runner.ts";
import type { SubagentDetails, SubagentExecutionResult } from "../src/extensions/subagent/types.ts";

const validateParams = Compile(SubagentParamsSchema);

const runSdkTaskMock = vi.hoisted(() => vi.fn());
vi.mock("../src/extensions/subagent/sdk-runner.ts", () => ({
	runSdkTask: runSdkTaskMock,
}));
// Isolate profile resolution from the developer's real ~/.pi/agent config:
// execute() reads subagent.json through getAgentDir(), whose overrides can
// reference models the fake registry here does not know.
vi.mock("../src/extensions/subagent/settings.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/extensions/subagent/settings.ts")>();
	return {
		...actual,
		loadSubagentConfig: vi.fn(async () => actual.emptySubagentConfig()),
	};
});

interface RegisteredCommand {
	name: string;
	description?: string;
	handler?: unknown;
}

// Collect string enum/const values anywhere in a TypeBox schema.
function stringValues(schema: unknown, output = new Set<string>()): string[] {
	if (schema && typeof schema === "object") {
		const record = schema as Record<string, unknown>;
		if (typeof record.const === "string") output.add(record.const);
		if (Array.isArray(record.enum)) {
			for (const value of record.enum) if (typeof value === "string") output.add(value);
		}
		for (const value of Object.values(record)) {
			if (value && typeof value === "object") stringValues(value, output);
		}
	}
	return [...output];
}

describe("subagent extension registration", () => {
	it("registers the static two-profile tool and maps terminal errors", async () => {
		const tools = new Map<string, ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>>();
		const commands: RegisteredCommand[] = [];
		const registeredEvents: string[] = [];
		let toolResultHandler:
			| ((event: { toolName: string; details?: unknown }) => Promise<{ isError: boolean } | undefined>)
			| undefined;
		const pi = {
			registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) =>
				tools.set(tool.name, tool),
			registerCommand: (name: string, options: RegisteredCommand) =>
				commands.push({ name, description: options.description, handler: options.handler }),
			on: (event: string, handler: unknown) => {
				registeredEvents.push(event);
				if (event === "tool_result") toolResultHandler = handler as typeof toolResultHandler;
			},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;

		subagent(pi);
		expect(tools).toHaveLength(1);
		const initialTool = tools.get("subagent");
		expect(initialTool).toMatchObject({ name: "subagent", label: "Subagent" });
		// The description is static: exactly the two built-in profiles. Concurrency
		// and input-order results live on the tasks parameter, not here.
		expect(initialTool?.description).toContain("Delegate bounded work to isolated one-shot subagents");
		expect(initialTool?.description).toContain("Workers cannot see the parent conversation");
		expect(initialTool?.description).toContain("Provide 1-8 independent tasks");
		expect(initialTool?.description).not.toContain("active at once");
		expect(initialTool?.description).toContain("Agent profiles:");
		expect(initialTool?.description).toContain("- explorer (default):");
		expect(initialTool?.description).toContain("- general:");
		expect(initialTool?.promptSnippet).toBe("Delegate bounded work to isolated explorer or general workers");
		expect(initialTool?.promptGuidelines).toEqual([
			"Use `subagent` for bounded work that benefits from isolated context or concurrent investigation; do not delegate a task you can finish with one or two direct tool calls.",
		]);
		expect(initialTool?.executionMode).toBeUndefined();
		expect(initialTool?.prepareArguments).toBeUndefined();
		// Providers reject tool schemas whose top level is not `type: "object"`,
		// e.g. a union; keep the parameter schema a plain object.
		expect((initialTool?.parameters as unknown as { type?: string }).type).toBe("object");
		expect(commands).toContainEqual({
			name: "agents",
			description: "Configure Subagent profiles, models, and thinking levels",
			handler: expect.any(Function),
		});
		// No user/project agent discovery hooks: the extension only listens for
		// tool results and shutdown, never session_start.
		expect(registeredEvents).not.toContain("session_start");
		expect(registeredEvents).toContain("tool_result");

		const failed = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "failed", runs: [{ status: "failed" }] },
		});
		// A batch where any run succeeded is a partial result, not an error.
		const partial = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "failed", runs: [{ status: "failed" }, { status: "completed" }] },
		});
		const completed = await toolResultHandler?.({
			toolName: "subagent",
			details: { status: "completed", runs: [{ status: "completed" }] },
		});
		expect(
			await toolResultHandler?.({
				toolName: "subagent",
				details: { status: "failed", runs: [{ status: "failed" }], background: { id: "group" } },
			}),
		).toBeUndefined();
		expect(failed).toEqual({ isError: true });
		expect(partial).toBeUndefined();
		expect(completed).toBeUndefined();
	});

	it("aborts queued tasks on session shutdown without ever starting them", async () => {
		// Regression: shutdown aborts used to be registered only once a worker
		// started, so a task still queued at the gate could slip past the
		// shutdown snapshot and start afterwards. Scopes must cover the whole
		// invocation from the batch start.
		runSdkTaskMock.mockReset();
		runSdkTaskMock.mockImplementation(
			(options: {
				scope: { onAbort: (handler: () => Promise<void> | void) => unknown };
				dispatch: (event: unknown) => void;
			}) =>
				new Promise<void>((resolve) => {
					options.scope.onAbort(() => {
						options.dispatch({
							type: "settle",
							verdict: "aborted",
							report: "",
							error: "Subagent was aborted.",
							endedAt: Date.now(),
						});
						resolve();
					});
				}),
		);
		let tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails> | undefined;
		const shutdownHandlers: Array<() => Promise<void>> = [];
		const pi = {
			registerTool: (definition: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) => {
				tool = definition;
			},
			registerCommand: () => {},
			on: (event: string, handler: unknown) => {
				if (event === "session_shutdown") shutdownHandlers.push(handler as () => Promise<void>);
			},
			getThinkingLevel: () => "medium",
		} as unknown as ExtensionAPI;
		subagent(pi);
		expect(tool).toBeDefined();

		const controller = new AbortController();
		const execution = tool!.execute(
			"call_shutdown_regression",
			{ tasks: Array.from({ length: 7 }, (_, index) => ({ prompt: `Task ${index + 1}.` })) },
			controller.signal,
			undefined,
			{
				cwd: process.cwd(),
				model: {
					id: "m",
					name: "m",
					api: "test-api",
					provider: "test",
					baseUrl: "https://example.test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				} as never,
				modelRuntime: {},
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
					hasConfiguredAuth: () => false,
				},
				isProjectTrusted: () => false,
			} as never,
		);
		// Six workers occupy the gate (the module default); the seventh queues.
		await vi.waitFor(() => expect(runSdkTaskMock).toHaveBeenCalledTimes(6));
		for (const handler of shutdownHandlers) await handler();
		const result = (await execution) as unknown as SubagentExecutionResult;
		// The queued run settled aborted without a worker ever starting.
		expect(runSdkTaskMock).toHaveBeenCalledTimes(6);
		const queued = result.details.runs[6];
		expect(queued?.status).toBe("aborted");
		expect(queued?.error).toContain("queued");
		for (const run of result.details.runs.slice(0, 6)) expect(run.status).toBe("aborted");
	});

	it("constrains the schema to a required 1-8 tasks array and the explorer|general enum", () => {
		// Structural view: TypeBox types hide JSON-schema knobs like
		// additionalProperties and array bounds behind their TS types.
		const paramsSchema = SubagentParamsSchema as unknown as {
			type: string;
			required: string[];
			additionalProperties: boolean;
			properties: Record<string, { type?: string; minItems?: number; maxItems?: number; description?: string }>;
		};
		const taskSchema = TaskSchema as unknown as {
			required: string[];
			additionalProperties: boolean;
			properties: Record<string, { type?: string; minLength?: number; description?: string }>;
		};
		expect(paramsSchema.type).toBe("object");
		expect(paramsSchema.required).toEqual(["tasks"]);
		expect(Object.keys(paramsSchema.properties)).toEqual(["background", "tasks"]);
		expect(paramsSchema.additionalProperties).toBe(false);
		expect(validateParams.Check({ background: true, tasks: [{ prompt: "Work" }] })).toBe(true);
		expect(validateParams.Check({ background: false, tasks: [{ prompt: "Work" }] })).toBe(true);
		expect(validateParams.Check({ tasks: [{ prompt: "Work", background: true }] })).toBe(false);
		// No legacy top-level mode or description fields survive.
		expect(paramsSchema.properties).not.toHaveProperty("mode");
		expect(paramsSchema.properties).not.toHaveProperty("description");

		const tasks = paramsSchema.properties.tasks;
		expect(tasks?.type).toBe("array");
		expect(tasks?.minItems).toBe(1);
		expect(tasks?.maxItems).toBe(8);
		expect(tasks?.description).toContain("at most 6 active at once");
		expect(tasks?.description).toContain("results preserve input order");

		expect(taskSchema.required).toEqual(["prompt"]);
		expect(taskSchema.additionalProperties).toBe(false);
		expect(Object.keys(taskSchema.properties).sort()).toEqual(["agent", "cwd", "prompt"]);
		expect(taskSchema.properties).not.toHaveProperty("mode");
		expect(taskSchema.properties).not.toHaveProperty("description");
		expect(taskSchema.properties.prompt?.type).toBe("string");
		expect(taskSchema.properties.prompt?.minLength).toBe(1);
		expect(validateParams.Check({ tasks: [{ agent: null, prompt: "Find it.", cwd: null }] })).toBe(true);
		const agentSchema = taskSchema.properties.agent as { description?: string };
		expect(agentSchema.description).toContain("null or omit for explorer (the default)");
		// The agent enum is exactly the two static profiles.
		expect(stringValues(agentSchema).sort()).toEqual(["explorer", "general"]);
	});
});

function managedHarness(enabled = true) {
	let tool!: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>;
	const settled = vi.fn();
	const service = new BackgroundService({ enabled, onSettled: settled });
	const execute = vi.spyOn(service, "execute");
	const shutdown: Array<() => Promise<void>> = [];
	subagent({
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: () => Promise<void>) => {
			if (name === "session_shutdown") shutdown.push(handler);
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		background: service,
		cwd: process.cwd(),
		model: { id: "m", provider: "test", reasoning: false },
		modelRegistry: {},
		modelRuntime: {},
		isProjectTrusted: () => false,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	return { tool, ctx, service, execute, settled, shutdown };
}

it.each([true, false])(
	"manages one entire invocation, background=%s, without restarting workers on detach",
	async (background) => {
		runSdkTaskMock.mockReset();
		const workers: Array<{ options: SdkRunnerOptions; finish: () => void }> = [];
		runSdkTaskMock.mockImplementation(
			(options: SdkRunnerOptions) =>
				new Promise<void>((resolve) => {
					workers.push({
						options,
						finish: () => {
							options.dispatch({
								type: "assistant_message_settled",
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
								},
							});
							options.dispatch({
								type: "settle",
								verdict: "completed",
								report: options.task.prompt,
								error: undefined,
								endedAt: Date.now(),
							});
							resolve();
						},
					});
				}),
		);
		const h = managedHarness();
		const parent = new AbortController();
		const updates = vi.fn();
		const submitted = h.tool.execute(
			"call-managed",
			{ background, tasks: Array.from({ length: 7 }, (_, i) => ({ prompt: `task ${i}` })) },
			parent.signal,
			updates,
			h.ctx,
		);
		await vi.waitFor(() => expect(workers).toHaveLength(6));
		if (!background) expect(h.service.detachForeground()).toBe(1);
		const result = await submitted;
		expect(result.details?.background?.id).toBe(h.service.list()[0]?.id);
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(h.service.detachForeground()).toBe(0);
		const callsAtHandoff = updates.mock.calls.length;
		parent.abort();
		for (const cleanup of h.shutdown) await cleanup(); // Managed executions are not owned by this closure.
		for (const worker of workers) expect(worker.options.scope.signal.aborted).toBe(false);
		const initial = h.service.list()[0]!;
		expect(initial.projection?.workers).toHaveLength(7);
		expect(initial.projection?.workers?.[0]).toMatchObject({ label: "#1 explorer", prompt: "task 0" });
		for (const worker of workers.slice(0, 6)) worker.finish();
		await vi.waitFor(() => expect(workers).toHaveLength(7));
		workers[6]!.finish();
		const final = await h.service.wait(initial.id, 1000);
		expect(final.status).toBe("completed");
		expect(final.projection?.workers?.map((worker) => worker.id)).toEqual(
			initial.projection?.workers?.map((worker) => worker.id),
		);
		expect(updates).toHaveBeenCalledTimes(callsAtHandoff);
		expect(h.settled).toHaveBeenCalledTimes(1);
		expect(h.settled.mock.calls[0]?.[1]).toMatchObject({ totalTokens: 14, cost: { total: expect.closeTo(0.7) } });
		expect(final.result?.usage).toBeUndefined();
		expect(result.details?.runs[6]?.status).toBe("queued"); // Historical snapshot stays unchanged.
		await h.service.shutdown();
	},
);

it("rejects a background batch before accepting or starting any worker when preflight fails", async () => {
	runSdkTaskMock.mockReset();
	const h = managedHarness();
	await expect(
		h.tool.execute(
			"bad-preflight",
			{ background: true, tasks: [{ prompt: "valid" }, { prompt: "invalid", cwd: "nonexistent-subagent-cwd" }] },
			undefined,
			undefined,
			h.ctx,
		),
	).rejects.toThrow("tasks[1] failed to resolve");
	expect(runSdkTaskMock).not.toHaveBeenCalled();
	expect(h.service.list()[0]?.status).toBe("failed");
	expect(h.service.pendingNotifications()).toEqual([]);
	await h.service.shutdown();
});

it("keeps disabled-host foreground fallback, while explicit background reaches host rejection", async () => {
	runSdkTaskMock.mockReset();
	runSdkTaskMock.mockImplementation(async (options: SdkRunnerOptions) => {
		options.dispatch({
			type: "settle",
			verdict: "completed",
			report: "legacy",
			error: undefined,
			endedAt: Date.now(),
		});
	});
	const h = managedHarness(false);
	const result = await h.tool.execute(
		"legacy",
		{ background: false, tasks: [{ prompt: "work" }] },
		undefined,
		undefined,
		h.ctx,
	);
	expect(result.details?.status).toBe("completed");
	expect(h.execute).not.toHaveBeenCalled();
	await expect(
		h.tool.execute("disabled", { background: true, tasks: [{ prompt: "work" }] }, undefined, undefined, h.ctx),
	).rejects.toThrow("not available");
	expect(h.execute).toHaveBeenCalledTimes(1);
	expect(runSdkTaskMock).toHaveBeenCalledTimes(1);
	await expect(
		h.tool.execute("missing", { background: true, tasks: [{ prompt: "work" }] }, undefined, undefined, {
			...h.ctx,
			background: undefined,
		} as unknown as ExtensionContext),
	).rejects.toThrow("Background host");
});

it.each([
	["completed", "failed", "partial"],
	["failed", "failed", "failed"],
	["aborted", "aborted", "cancelled"],
] as const)(
	"preserves ordered %s/%s reports and maps the managed terminal status to %s",
	async (first, second, status) => {
		runSdkTaskMock.mockReset();
		runSdkTaskMock.mockImplementation(async (options: SdkRunnerOptions) => {
			const verdict = options.task.prompt === "first" ? first : second;
			options.dispatch({
				type: "settle",
				verdict,
				report: `${options.task.prompt} report`,
				error: verdict === "completed" ? undefined : "reason",
				endedAt: Date.now(),
			});
		});
		const h = managedHarness();
		const result = await h.tool.execute(
			"statuses",
			{ tasks: [{ prompt: "first" }, { prompt: "second" }] },
			undefined,
			undefined,
			h.ctx,
		);
		expect(h.service.list()[0]?.status).toBe(status);
		expect(result.details?.runs.map((run) => run.status)).toEqual([first, second]);
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		expect(text.indexOf("first report")).toBeLessThan(text.indexOf("second report"));
		expect(text).toContain("reason");
		expect(result.usage).toBeUndefined();
		expect(result.details?.background).toBeUndefined();
		expect(h.settled).toHaveBeenCalledTimes(1);
		await h.service.shutdown();
	},
);
