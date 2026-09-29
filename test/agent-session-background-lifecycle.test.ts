import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getBackgroundUsageRecord } from "../src/core/usage-totals.ts";
import type { ExtensionFactory } from "../src/index.ts";

describe("AgentSessionRuntime background lifecycle", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("holds the outgoing session's completions while replacement hooks decide", async () => {
		let reachedHook!: () => void;
		let releaseHook!: () => void;
		const reached = new Promise<void>((resolve) => {
			reachedHook = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", async () => {
				reachedHook();
				await released;
				return { cancel: true };
			});
		});
		const session = runtimeHost.session;
		await session.bindExtensions({ backgroundEnabled: true });
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const outcome = await session.background.execute({
			kind: "bash",
			title: "worker",
			toolCallId: "worker",
			background: true,
			run: async (control) => {
				control.accept();
				await done;
				return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
			},
		});
		if (outcome.kind !== "background") throw new Error("expected handoff");
		const delivered = () =>
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length;

		const replacing = runtimeHost.newSession();
		await reached;
		finish();
		await vi.waitFor(() => expect(session.background.get(outcome.task.id).status).toBe("completed"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(delivered()).toBe(0);
		releaseHook();
		expect((await replacing).cancelled).toBe(true);
		await vi.waitFor(() => expect(delivered()).toBe(1));
		await session.waitForIdle();
	});

	it("preserves background admission on veto and closes it before shutdown hooks on replacement", async () => {
		let veto = true;
		let enabledAtShutdown: boolean | undefined;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", () => ({ cancel: veto }));
			pi.on("session_shutdown", (_event, ctx) => {
				enabledAtShutdown = ctx.background.enabled;
			});
		});
		await runtimeHost.session.bindExtensions({ backgroundEnabled: true });
		const old = runtimeHost.session.background;
		expect((await runtimeHost.newSession()).cancelled).toBe(true);
		expect(old.enabled).toBe(true);
		veto = false;
		await runtimeHost.newSession();
		expect(enabledAtShutdown).toBe(false);
		expect(old.enabled).toBe(false);
		expect(runtimeHost.session.background).not.toBe(old);
		expect(runtimeHost.session.background.enabled).toBe(false);
	});

	it("fork veto preserves workers and a current-leaf fork copies cooperative shutdown usage", async () => {
		let veto = true;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", () => ({ cancel: veto }));
		});
		const old = runtimeHost.session;
		await old.bindExtensions({ backgroundEnabled: true });
		await old.prompt("persist source");
		const leaf = old.sessionManager.getLeafId()!;
		let signal!: AbortSignal;
		const outcome = await old.background.execute({
			kind: "subagent",
			title: "billable",
			toolCallId: "billable",
			background: true,
			run: async (control) => {
				signal = control.signal;
				control.accept();
				await new Promise<void>((resolve) =>
					control.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return {
					status: "cancelled",
					result: {
						content: [],
						details: undefined,
						usage: { ...fauxAssistantMessage("").usage, input: 7, totalTokens: 7 },
					},
				};
			},
		});
		if (outcome.kind !== "background") throw new Error("expected handoff");
		expect((await runtimeHost.fork(leaf, { position: "at" })).cancelled).toBe(true);
		expect(signal.aborted).toBe(false);
		expect(old.background.enabled).toBe(true);
		veto = false;
		await runtimeHost.fork(leaf, { position: "at" });
		expect(signal.aborted).toBe(true);
		const ledger = runtimeHost.session.sessionManager.getEntries().map(getBackgroundUsageRecord).filter(Boolean);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ taskId: outcome.task.id, usage: { input: 7 } });
		expect(runtimeHost.session.background.list()).toMatchObject([{ id: outcome.task.id, status: "cancelled" }]);
		expect(runtimeHost.session.background.pendingNotifications()).toEqual([]);
	});

	it("persists late ignored-abort accounting beside the source, never into a replacement session", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const old = runtimeHost.session;
		await old.bindExtensions({ backgroundEnabled: true });
		await old.prompt("persist source");
		const source = old.sessionFile!;
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const outcome = await old.background.execute({
			kind: "subagent",
			title: "late",
			toolCallId: "late",
			background: true,
			run: async (control) => {
				control.accept();
				await gate;
				return {
					result: {
						content: [],
						details: undefined,
						usage: { ...fauxAssistantMessage("").usage, input: 9, totalTokens: 9 },
					},
				};
			},
		});
		if (outcome.kind !== "background") throw new Error("expected handoff");
		const shutdown = old.background.shutdown.bind(old.background);
		vi.spyOn(old.background, "shutdown").mockImplementation(() => shutdown(0));
		await runtimeHost.newSession();
		const original = readFileSync(source, "utf8");
		const replacementEntries = runtimeHost.session.sessionManager.getEntries();
		finish();
		await vi.waitFor(() => expect(old.quarantinedBackgroundSettlements).toHaveLength(1));
		expect(readFileSync(source, "utf8")).toBe(original);
		expect(runtimeHost.session.sessionManager.getEntries()).toEqual(replacementEntries);
		const record = JSON.parse(readFileSync(`${source}.background-late.jsonl`, "utf8").trim());
		expect(record).toMatchObject({ sessionId: old.sessionId, task: { id: outcome.task.id }, usage: { input: 9 } });
	});
});
