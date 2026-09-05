import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { BackgroundControl } from "../src/core/background/types.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BACKGROUND_USAGE_TYPE } from "../src/core/usage-totals.ts";
import { runWait } from "../src/extensions/background/actions.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader, userMsg } from "./utilities.ts";

const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("session-owned background host", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	async function host(
		role: "main" | "subagent" = "main",
		factory?: ExtensionFactory,
		responses?: AssistantMessage[],
		manager = SessionManager.inMemory(),
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
				streamFn: streamSimple,
			}),
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			cwd: process.cwd(),
			modelRuntime,
			executionRole: role,
			resourceLoader: createTestResourceLoader({
				extensionsResult: await createTestExtensionsResult(factory ? [factory] : []),
			}),
		});
		cleanups.push(() => session.dispose());
		return session;
	}

	async function task(session: AgentSession) {
		let finish!: () => void;
		let control!: BackgroundControl<undefined>;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const outcome = await session.background.execute({
			kind: "subagent",
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

	it("is disabled unbound and subagent role cannot be enabled", async () => {
		const session = await host();
		const ctx = session.extensionRunner.createContext();
		expect(ctx.background).toBe(session.background);
		expect(ctx.background.enabled).toBe(false);
		await session.bindExtensions({ backgroundEnabled: true });
		expect(ctx.background.enabled).toBe(true);
		const worker = await host("subagent");
		await worker.bindExtensions({ backgroundEnabled: true });
		worker.background.setEnabled(true);
		expect(worker.background.enabled).toBe(false);
		const run = vi.fn();
		await expect(
			worker.background.execute({ kind: "bash", title: "no", toolCallId: "no", background: true, run }),
		).rejects.toThrow("inside subagents");
		expect(run).not.toHaveBeenCalled();
	});

	it("settles usage before consumption and schedules a bounded persisted notification", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const resume = session.pauseBackgroundNotifications();
		const entries: string[] = [];
		session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom") entries.push(event.entry.customType);
		});
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.background.get(execution.id).status).toBe("completed"));
		expect(entries).toEqual([BACKGROUND_USAGE_TYPE, "background-task-result"]);
		expect(session.getSessionStats().tokens.total).toBe(30);
		expect(session.messages).toHaveLength(0);
		resume();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		const notifications = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(notifications).toHaveLength(1);
		const notification = notifications[0];
		if (notification.type !== "custom_message") throw new Error("expected notification");
		expect(notification.customType).toBe("background-completion");
		expect(notification.details).toEqual({ taskId: execution.id });
		expect(Buffer.byteLength(String(notification.content))).toBeLessThanOrEqual(50 * 1024);
		expect(session.background.pendingNotifications()).toHaveLength(0);
		await session.background.read(execution.id);
		await session.background.wait(execution.id, 0);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === BACKGROUND_USAGE_TYPE),
		).toHaveLength(1);
	});

	it.each(["malformed", "foreign", "running", "foreground"] as const)(
		"does not acknowledge a %s outcome marker",
		async (mode) => {
			let marker: unknown;
			const session = await host(
				"main",
				(pi) => {
					pi.registerTool({
						name: "marker",
						label: "marker",
						description: "marker",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: { backgroundTaskId: marker } }),
					});
				},
				[
					{
						...fauxAssistantMessage(""),
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "marker-1", name: "marker", arguments: {} }],
					},
					fauxAssistantMessage("done"),
				],
			);
			await session.bindExtensions({ backgroundEnabled: true });
			session.pauseBackgroundNotifications();
			const execution = await task(session);
			marker = mode === "malformed" ? 42 : mode === "foreign" ? "subagent-foreign" : execution.id;
			if (mode === "foreground") {
				await session.background.execute({
					kind: "bash",
					title: "foreground",
					toolCallId: "foreground",
					run: async () => ({ result: { content: [], details: undefined } }),
				});
				marker = session.background.list().find((task) => task.mode === "foreground")!.id;
			}
			const delivered = vi.spyOn(session.background, "markDelivered");
			await session.prompt("marker");
			expect(delivered).not.toHaveBeenCalled();
			execution.finish();
		},
	);

	it.each(["persist", "abort", "remove-marker"] as const)(
		"coordinates terminal wait delivery at persistence: %s",
		async (mode) => {
			let id = "";
			let releaseRead!: () => void;
			const readGate = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			let readStarted!: () => void;
			const reading = new Promise<void>((resolve) => {
				readStarted = resolve;
			});
			const session = await host(
				"main",
				(pi) => {
					pi.registerTool({
						name: "wait_test",
						label: "wait",
						description: "wait",
						parameters: Type.Object({}),
						execute: (_call, _args, signal, _update, ctx) =>
							runWait(ctx.background, { action: "wait", taskId: id }, signal),
					});
					if (mode === "remove-marker") {
						pi.on("tool_result", () => ({ details: {} }));
					}
				},
				[
					{
						...fauxAssistantMessage(""),
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "wait-1", name: "wait_test", arguments: {} }],
					},
					fauxAssistantMessage("finished"),
					fauxAssistantMessage("noticed"),
				],
			);
			await session.bindExtensions({ backgroundEnabled: true });
			const execution = await task(session);
			id = execution.id;
			const read = session.background.read.bind(session.background);
			vi.spyOn(session.background, "read").mockImplementation(async (...args) => {
				readStarted();
				await readGate;
				return read(...args);
			});
			const delivered = vi.spyOn(session.background, "markDelivered");
			const append = session.sessionManager.appendMessage.bind(session.sessionManager);
			vi.spyOn(session.sessionManager, "appendMessage").mockImplementation((message) => {
				if (message.role === "toolResult") expect(delivered).not.toHaveBeenCalled();
				return append(message);
			});
			const prompting = session.prompt("wait for task");
			execution.finish();
			await reading;
			expect(session.background.get(id).status).toBe("completed");
			expect(delivered).not.toHaveBeenCalled();
			expect(session.messages.some((message) => message.role === "custom")).toBe(false);
			// Abort deterministically after core wait resolved, while output read is pending.
			if (mode === "abort") session.agent.abort();
			releaseRead();
			await prompting;
			if (mode !== "persist") {
				await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
				await session.waitForIdle();
			} else {
				expect(session.messages.some((message) => message.role === "custom")).toBe(false);
				const result = session.messages.find((message) => message.role === "toolResult");
				expect(result?.role === "toolResult" && result.details).toMatchObject({ backgroundTaskId: id });
			}
			expect(delivered).toHaveBeenCalledExactlyOnceWith(id);
			expect(session.background.pendingNotifications()).toEqual([]);
		},
	);

	it("restores completed snapshots on startup and reload without execution, notification, or double accounting", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const resume = session.pauseBackgroundNotifications();
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.background.get(execution.id).status).toBe("completed"));
		const before = session.sessionManager.getEntries();
		await session.reload();
		await session.reload();
		expect(session.background.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		expect(session.background.pendingNotifications()).toEqual([]);
		expect(session.sessionManager.getEntries()).toEqual(before);
		expect(session.getSessionStats().tokens.total).toBe(30);
		resume();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.messages).toEqual([]);
		const restored = await host("main", undefined, undefined, session.sessionManager);
		expect(restored.background.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		expect(restored.getSessionStats().tokens.total).toBe(30);
		expect(restored.background.pendingNotifications()).toEqual([]);
	});

	it("restores only valid current-branch envelopes and merges tree history without duplicate IDs", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		session.pauseBackgroundNotifications();
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.background.get(execution.id).status).toBe("completed"));
		const resultLeaf = session.sessionManager.getLeafId()!;
		const snapshot = session.background.get(execution.id);
		await session.navigateTree(root);
		await session.reload();
		expect(session.background.list()).toEqual([]);
		const invalid = [null, { version: 2, task: snapshot }, { version: 1, task: { ...snapshot, status: "running" } }];
		for (const record of invalid) session.sessionManager.appendCustomEntry("background-task-result", record);
		session.sessionManager.appendCustomEntry("unrelated", { version: 1, task: snapshot });
		await session.reload();
		expect(session.background.list()).toEqual([]);
		await session.navigateTree(resultLeaf);
		expect(session.background.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		session.sessionManager.appendMessage(userMsg("later"));
		await session.navigateTree(resultLeaf);
		expect(session.background.list()).toHaveLength(1);
		expect(session.background.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
	});

	it("caps restored history at the runtime terminal-history limit", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		session.pauseBackgroundNotifications();
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.background.get(execution.id).status).toBe("completed"));
		const snapshot = session.background.get(execution.id);
		for (let index = 0; index < 40; index++) {
			session.sessionManager.appendCustomEntry("background-task-result", {
				version: 1,
				task: { ...snapshot, id: `subagent-history-${index}`, endedAt: snapshot.endedAt! + index + 1 },
			});
		}
		await session.reload();
		expect(session.background.list()).toHaveLength(32);
		expect(session.background.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
	});

	it("allows completion turns while an observer command remains open", async () => {
		let close!: () => void;
		let opened = false;
		const panel = new Promise<void>((resolve) => {
			close = resolve;
		});
		const session = await host("main", (pi) => {
			pi.registerCommand("observer", {
				handler: async () => {
					opened = true;
					await panel;
				},
			});
		});
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		const command = session.prompt("/observer");
		expect(opened).toBe(true);
		execution.finish();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		close();
		await command;
	});

	it("quarantines ignored-abort settlement after reload without mutating the new generation", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		const service = session.background;
		const shutdown = service.shutdown.bind(service);
		vi.spyOn(service, "shutdown").mockImplementation(() => shutdown(0));
		await session.reload();
		const leaf = session.sessionManager.appendMessage(userMsg("new generation"));
		const count = session.sessionManager.getEntries().length;
		expect(execution.control.signal.aborted).toBe(true);
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedBackgroundSettlements).toHaveLength(1));
		expect(session.quarantinedBackgroundSettlements[0]).toMatchObject({ task: { id: execution.id }, usage });
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		expect(session.background.list()).toHaveLength(0);
		expect(session.messages).toHaveLength(0);
	});

	it("quarantines ignored-abort settlement after tree navigation", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		session.sessionManager.appendMessage(userMsg("next"));
		await session.navigateTree(root);
		expect(execution.control.signal.aborted).toBe(true);
		const count = session.sessionManager.getEntries().length;
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedBackgroundSettlements).toHaveLength(1));
		expect(session.quarantinedBackgroundSettlements[0].usage).toEqual(usage);
		expect(session.sessionManager.getLeafId()).toBeNull();
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		expect(session.messages).toHaveLength(0);
	}, 10_000);

	it("keeps late usage out of a reused in-memory session manager", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		session.dispose();
		session.sessionManager.newSession();
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedBackgroundSettlements).toHaveLength(1));
		expect(session.sessionManager.getEntries()).toHaveLength(0);
		expect(session.quarantinedBackgroundSettlements[0].usage).toEqual(usage);
	});

	it("bounds late snapshots and diagnoses unpersisted usage even when diagnostics throw", async () => {
		const session = await host();
		const warning = vi.fn((_error: { event?: string; error: string }) => {
			throw new Error("observer failed");
		});
		await session.bindExtensions({ backgroundEnabled: true, onError: warning });
		let lastId = "";
		for (let batch = 0; batch < 5; batch++) {
			const executions = await Promise.all(Array.from({ length: batch === 4 ? 1 : 8 }, () => task(session)));
			const service = session.background;
			const shutdown = service.shutdown.bind(service);
			vi.spyOn(service, "shutdown").mockImplementation(() => shutdown(0));
			await session.reload();
			for (const execution of executions) execution.finish();
			await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(Math.min((batch + 1) * 8, 33)));
			lastId = executions.at(-1)!.id;
		}
		expect(session.quarantinedBackgroundSettlements).toHaveLength(32);
		expect(session.quarantinedBackgroundSettlements.at(-1)?.task.id).toBe(lastId);
		expect(warning.mock.calls.at(-1)?.[0]).toMatchObject({
			event: "background_settlement_quarantined",
			error: expect.stringContaining("Not persisted"),
		});
		expect(session.sessionManager.getEntries()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(0);
	});

	it("reports sidecar persistence failure without writing to the active session", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ backgroundEnabled: true, onError: warning });
		// A repository file cannot be the sidecar's parent directory.
		vi.spyOn(session.sessionManager, "getSessionFile").mockReturnValue(
			join(process.cwd(), "AGENTS.md", "session.jsonl"),
		);
		await session.reload();
		const execution = await task(session);
		session.dispose();
		execution.finish();
		await vi.waitFor(() =>
			expect(warning).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "background_settlement_quarantined",
					error: expect.stringContaining("Sidecar write failed. Not persisted"),
				}),
			),
		);
		expect(session.quarantinedBackgroundSettlements).toHaveLength(1);
		expect(session.sessionManager.getEntries()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(0);
	});

	it("contains escaped scheduled drain failures and cleanup warnings", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ backgroundEnabled: true, onError: warning });
		const pending = vi.spyOn(session.background, "pendingNotifications").mockImplementation(() => {
			throw new Error("observer escaped");
		});
		session.retryBackgroundNotifications();
		await vi.waitFor(() =>
			expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "background_delivery" })),
		);
		pending.mockRestore();
		await session.background.execute({
			kind: "bash",
			title: "cleanup",
			toolCallId: "cleanup",
			run: async (control) => {
				control.setOutputPath("unused-output", () => {
					throw new Error("cleanup failed".repeat(1000));
				});
				return { result: { content: [], details: undefined } };
			},
		});
		await session.background.shutdown();
		const cleanup = warning.mock.calls.find(([error]) => error.event === "background_cleanup")?.[0];
		expect(cleanup).toBeDefined();
		expect(Buffer.byteLength(cleanup.error)).toBeLessThanOrEqual(4096);
	});

	it("gives user preflight priority and never injects while input hooks are pending", async () => {
		let acceptInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			acceptInput = resolve;
		});
		const session = await host("main", (pi) => {
			pi.on("input", async () => {
				await inputGate;
			});
		});
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		const prompting = session.prompt("user request");
		execution.finish();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.messages).toHaveLength(0);
		acceptInput();
		await prompting;
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		expect(session.messages[0].role).toBe("user");
	});

	it("waits for the complete main tool batch and settled hooks before starting a notification turn", async () => {
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolStarted = false;
		let inSettledHook = false;
		const session = await host(
			"main",
			(pi) => {
				pi.registerTool({
					name: "hold",
					label: "hold",
					description: "hold",
					parameters: Type.Object({}),
					execute: async () => {
						toolStarted = true;
						await toolGate;
						return { content: [{ type: "text", text: "held result" }], details: undefined };
					},
				});
				pi.on("agent_settled", async () => {
					inSettledHook = true;
					await new Promise((resolve) => setTimeout(resolve, 10));
					inSettledHook = false;
				});
				pi.on("agent_start", () => {
					expect(inSettledHook).toBe(false);
				});
			},
			[
				{
					...fauxAssistantMessage(""),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }],
				},
				fauxAssistantMessage("batch complete"),
				fauxAssistantMessage("background noticed"),
			],
		);
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		const prompting = session.prompt("run tool");
		await vi.waitFor(() => expect(toolStarted).toBe(true));
		execution.finish();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.messages.some((message) => message.role === "custom")).toBe(false);
		releaseTool();
		await prompting;
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		const roles = session.messages.map((message) => message.role);
		expect(roles.indexOf("custom")).toBeGreaterThan(roles.indexOf("toolResult"));
	});

	it.each(["reject", "drop"] as const)(
		"does not timer-retry a %s delivery without explicit host retry",
		async (mode) => {
			const session = await host();
			await session.bindExtensions({ backgroundEnabled: true });
			const deliver = vi.spyOn(session, "sendCustomMessage").mockImplementation(async () => {
				if (mode === "reject") throw new Error("persistence failed");
			});
			const execution = await task(session);
			execution.finish();
			await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
			session.background.setEnabled(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deliver).toHaveBeenCalledOnce();
			expect(session.background.pendingNotifications()).toHaveLength(1);
			deliver.mockRestore();
			session.retryBackgroundNotifications();
			await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
			await session.waitForIdle();
			expect(session.background.pendingNotifications()).toHaveLength(0);
		},
	);

	it("acknowledges a persisted notification even when extensions replace its metadata", async () => {
		const session = await host("main", (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role === "custom")
					return { message: { ...event.message, details: undefined, customType: "transformed" } };
			});
		});
		await session.bindExtensions({ backgroundEnabled: true });
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		expect(session.background.pendingNotifications()).toHaveLength(0);
		session.retryBackgroundNotifications();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("closes captured service synchronously on dispose", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const service = session.background;
		const execution = await task(session);
		session.dispose();
		expect(execution.control.signal.aborted).toBe(true);
		expect(service.enabled).toBe(false);
		execution.finish();
	});

	it("settles cooperative workers and their ledger before extension shutdown hooks", async () => {
		let ledgerAtShutdown = false;
		const session = await host("main", (pi) => {
			pi.on("session_shutdown", (_event, ctx) => {
				ledgerAtShutdown = ctx.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === BACKGROUND_USAGE_TYPE);
			});
		});
		await session.bindExtensions({ backgroundEnabled: true });
		await session.background.execute({
			kind: "subagent",
			title: "worker",
			toolCallId: "worker",
			background: true,
			run: async (control) => {
				control.accept();
				await new Promise<void>((resolve) =>
					control.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return { status: "cancelled", result: { content: [], details: undefined, usage } };
			},
		});
		await session.reload();
		expect(ledgerAtShutdown).toBe(true);
		expect(session.background.list()).toMatchObject([{ status: "cancelled" }]);
		expect(session.background.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
		expect(session.messages).toHaveLength(0);
	});

	it("reload closes admission before async cleanup and replaces captured capability", async () => {
		let shutdownEnabled: boolean | undefined;
		const session = await host("main", (pi) => {
			pi.on("session_shutdown", (_event, ctx) => {
				shutdownEnabled = ctx.background.enabled;
			});
		});
		await session.bindExtensions({ backgroundEnabled: true });
		const service = session.background;
		const ctx = session.extensionRunner.createContext();
		const reloading = session.reload();
		expect(service.enabled).toBe(false);
		await reloading;
		expect(shutdownEnabled).toBe(false);
		expect(session.background).not.toBe(service);
		expect(session.background.enabled).toBe(true);
		expect(() => ctx.background).toThrow("stale");
	});

	it("tree uses the destination parent path, including explicit root", async () => {
		const session = await host();
		await session.bindExtensions({ backgroundEnabled: true });
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		const cancel = vi.spyOn(session.background, "cancelOutsideBranch").mockImplementation(async (ancestors) => {
			expect(ancestors.size).toBe(0);
			expect(session.sessionManager.getLeafId()).toBe(root);
		});
		await session.navigateTree(`${root}missing`).catch(() => {});
		expect(cancel).not.toHaveBeenCalled();
		session.sessionManager.appendMessage(userMsg("next"));
		cancel.mockImplementation(async (ancestors) => {
			expect(ancestors.size).toBe(0);
		});
		await session.navigateTree(root);
		expect(cancel).toHaveBeenCalledOnce();
		expect(session.sessionManager.getLeafId()).toBeNull();
		execution.finish();
	});
});
