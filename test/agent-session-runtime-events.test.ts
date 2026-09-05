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
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
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

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
