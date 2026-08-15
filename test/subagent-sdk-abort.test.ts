import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { createRunCancellation } from "../src/extensions/subagent/cancellation.ts";
import { runSdkTask } from "../src/extensions/subagent/sdk-runner.ts";
import { createRunState, reduceRun, type SubagentRunState } from "../src/extensions/subagent/state.ts";
import type { ResolvedSubagentTask } from "../src/extensions/subagent/types.ts";

const sdkMocks = vi.hoisted(() => ({
	reload: vi.fn(),
	createAgentSession: vi.fn(),
}));

vi.mock("../src/core/resource-loader.ts", () => ({
	DefaultResourceLoader: class {
		reload(): Promise<void> {
			return sdkMocks.reload();
		}
	},
}));

vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: {
		create: vi.fn(() => ({})),
	},
}));

vi.mock("../src/core/sdk.ts", () => ({
	createAgentSession: sdkMocks.createAgentSession,
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function model(): Model<Api> {
	return {
		id: "model",
		name: "model",
		api: "test-api" as Api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1000,
	} as Model<Api>;
}

function task(): ResolvedSubagentTask {
	return {
		agent: {
			name: "explorer",
			description: "Read-only exploration",
			tools: ["read", "grep", "find", "ls", "bash"],
			systemPrompt: "Inspect the code.",
			omitContextFiles: true,
		},
		description: "Inspect initialization",
		prompt: "Inspect without starting after abort.",
		cwd: process.cwd(),
		model: model(),
		thinking: "low",
	};
}

function fakeSession() {
	return {
		messages: [],
		subscribe: vi.fn(() => vi.fn()),
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
	};
}

interface Harness {
	scope: ReturnType<typeof createRunCancellation>;
	done: Promise<void>;
	state(): SubagentRunState;
}

function start(signal?: AbortSignal): Harness {
	const scope = createRunCancellation(signal);
	let state = createRunState(task(), 0, undefined, process.cwd());
	const done = runSdkTask({
		task: task(),
		scope,
		dispatch: (event) => {
			state = reduceRun(state, event);
		},
		modelRuntime: {} as ModelRuntime,
		agentDir: process.cwd(),
		projectTrusted: false,
	});
	return { scope, done, state: () => state };
}

describe("Subagent SDK initialization aborts", () => {
	beforeEach(() => {
		sdkMocks.reload.mockReset();
		sdkMocks.createAgentSession.mockReset();
	});

	it("does not prompt when the parent aborts during session creation", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		const created = deferred<{ session: ReturnType<typeof fakeSession> }>();
		sdkMocks.createAgentSession.mockReturnValue(created.promise);
		const session = fakeSession();
		const controller = new AbortController();
		const execution = start(controller.signal);
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		controller.abort();
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(execution.state().error).toContain("during initialization");
		// The abort wins the creation race: the run settles immediately and
		// the never-assigned session never needs an abort.
		expect(session.abort).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		// The late-resolving session is disposed instead of leaking.
		created.resolve({ session });
		await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));
	});

	it("settles immediately when the resource loader never resolves and the scope aborts", async () => {
		// Regression: the initialization race must cover resource loading,
		// not only session creation. A loader that hangs forever cannot keep
		// the run unsettled after an abort.
		sdkMocks.reload.mockReturnValue(new Promise<void>(() => {}));
		const execution = start();
		await vi.waitFor(() => expect(sdkMocks.reload).toHaveBeenCalledTimes(1));

		await execution.scope.abort();
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(execution.state().error).toContain("during initialization");
		expect(sdkMocks.createAgentSession).not.toHaveBeenCalled();
	});

	it("settles aborted while session creation hangs instead of leaking the run", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		sdkMocks.createAgentSession.mockReturnValue(new Promise<{ session: unknown }>(() => {}));
		const controller = new AbortController();
		const execution = start(controller.signal);
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		controller.abort();
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(execution.state().error).toContain("aborted");
	});

	it("settles a hanging creation through a direct scope abort (session shutdown path)", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		sdkMocks.createAgentSession.mockReturnValue(new Promise<{ session: unknown }>(() => {}));
		const execution = start();
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		await execution.scope.abort();
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(execution.state().error).toContain("during initialization");
	});

	it("disposes exactly once when creation resolves immediately before abort", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		const created = deferred<{ session: ReturnType<typeof fakeSession> }>();
		sdkMocks.createAgentSession.mockReturnValue(created.promise);
		const session = fakeSession();
		const controller = new AbortController();
		const execution = start(controller.signal);
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		created.resolve({ session });
		controller.abort();
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalledTimes(1);
	});

	it("settles through the scope while resources are still loading", async () => {
		const loading = deferred<void>();
		sdkMocks.reload.mockReturnValue(loading.promise);
		const execution = start();
		await vi.waitFor(() => expect(sdkMocks.reload).toHaveBeenCalledTimes(1));

		await execution.scope.abort();
		// The run settles without waiting for the loader to finish.
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(sdkMocks.createAgentSession).not.toHaveBeenCalled();
		// The abandoned loader chain resolves harmlessly later.
		loading.resolve();
	});

	it("settles before it starts when the scope was already aborted", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		const controller = new AbortController();
		controller.abort();
		const execution = start(controller.signal);
		await execution.done;
		expect(execution.state().status).toBe("aborted");
		expect(execution.state().error).toBe("Subagent was aborted before it started.");
		expect(sdkMocks.reload).not.toHaveBeenCalled();
	});
});
