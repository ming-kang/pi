import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { afterEach } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";
import tasksExtension from "../src/extensions/tasks/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

export const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

/**
 * AgentSession fixtures for background tests. Call inside a `describe`: it registers the
 * cleanup that disposes every session it created.
 */
export function backgroundSessionTest() {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	async function host(
		backgroundAllowed = true,
		factory?: ExtensionFactory,
		responses?: AssistantMessage[],
		manager = SessionManager.inMemory(),
		streamFn: StreamFn = streamSimple,
	) {
		const faux = registerFauxProvider();
		faux.setResponses(responses ?? [fauxAssistantMessage("noticed"), fauxAssistantMessage("user first")]);
		cleanups.push(() => faux.unregister());
		const auth = AuthStorage.inMemory();
		await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "test" }));
		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(auth));
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			models: [model],
		});
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: faux.getModel(), tools: [] },
				getApiKey: () => "test",
				streamFn,
			}),
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			cwd: process.cwd(),
			modelRuntime,
			backgroundAllowed,
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult(factory ? [tasksExtension, factory] : [tasksExtension]),
			}),
		});
		cleanups.push(() => session.dispose());
		return session;
	}

	async function task(session: AgentSession) {
		let finish!: () => void;
		let control!: TaskControl<undefined>;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const outcome = await session.tasks.execute({
			kind: "custom",
			title: "group",
			toolCallId: "call",
			background: true,
			run: async (ctx) => {
				control = ctx;
				ctx.accept();
				await done;
				return {
					result: {
						content: [{ type: "text", text: `result ${"界".repeat(30_000)}` }],
						details: undefined,
						usage,
					},
				};
			},
		});
		if (outcome.kind !== "background") throw new Error("expected handoff");
		return { id: outcome.task.id, finish, control };
	}

	return { host, task };
}
