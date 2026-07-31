import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { emptyUsage } from "../src/extensions/subagent/activity.ts";
import { runSdkTask } from "../src/extensions/subagent/sdk-runner.ts";
import type { ResolvedSubagentTask, SubagentRunDetails } from "../src/extensions/subagent/types.ts";

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
			name: "worker",
			description: "Test worker",
			tools: ["read"],
			systemPrompt: "Inspect the code.",
			source: "builtin",
			filePath: "builtin",
			backend: "sdk",
		},
		description: "Inspect initialization",
		prompt: "Inspect without starting after abort.",
		cwd: process.cwd(),
		model: model(),
		thinking: "low",
		modelSource: "parent",
		thinkingSource: "parent",
	};
}

function run(): SubagentRunDetails {
	return {
		id: "subagent-1",
		agent: "worker",
		agentSource: "builtin",
		description: "Inspect initialization",
		prompt: "Inspect without starting after abort.",
		cwd: "",
		model: "test/model",
		thinking: "low",
		status: "queued",
		activities: [],
		liveText: "",
		finalOutput: "",
		usage: emptyUsage(),
	};
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
		const execution = runSdkTask({
			task: task(),
			run: run(),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		controller.abort();
		const result = await execution;
		expect(result.status).toBe("aborted");
		// The abort wins the creation race: the run settles immediately and
		// the never-assigned session never needs an abort.
		expect(session.abort).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
		// The late-resolving session is disposed instead of leaking.
		created.resolve({ session });
		await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledTimes(1));
	});

	it("settles aborted while session creation hangs instead of leaking the run", async () => {
		sdkMocks.reload.mockResolvedValue(undefined);
		sdkMocks.createAgentSession.mockReturnValue(new Promise<{ session: unknown }>(() => {}));
		const controller = new AbortController();
		const execution = runSdkTask({
			task: task(),
			run: run(),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(sdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

		controller.abort();
		const result = await execution;
		expect(result.status).toBe("aborted");
		expect(result.error).toContain("aborted");
	});

	it("registers session-shutdown abort while resources are still loading", async () => {
		const loading = deferred<void>();
		sdkMocks.reload.mockReturnValue(loading.promise);
		let registeredAbort: (() => Promise<void>) | undefined;
		const unregisterAbort = vi.fn();
		const execution = runSdkTask({
			task: task(),
			run: run(),
			modelRuntime: {} as ModelRuntime,
			agentDir: process.cwd(),
			projectTrusted: false,
			registerAbort: (abort) => {
				registeredAbort = abort;
				return unregisterAbort;
			},
		});
		await vi.waitFor(() => expect(sdkMocks.reload).toHaveBeenCalledTimes(1));

		await registeredAbort?.();
		loading.resolve();
		const result = await execution;
		expect(result.status).toBe("aborted");
		expect(sdkMocks.createAgentSession).not.toHaveBeenCalled();
		expect(unregisterAbort).toHaveBeenCalledTimes(1);
	});
});

function fakeSession() {
	return {
		messages: [],
		subscribe: vi.fn(() => vi.fn()),
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
	};
}
