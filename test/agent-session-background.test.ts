import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";
import { TASK_USAGE_TYPE } from "../src/core/usage-totals.ts";
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
				extensionsResult: await createTestExtensionsResult(factory ? [factory] : []),
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

	it("is disabled unbound and a host prohibition survives binding, direct enable and reload", async () => {
		const session = await host();
		const ctx = session.extensionRunner.createContext();
		expect(ctx.tasks).toBe(session.tasks);
		expect(ctx.tasks.enabled).toBe(false);
		await session.bindExtensions({ tasksEnabled: true });
		expect(ctx.tasks.enabled).toBe(true);
		const worker = await host(false);
		await worker.bindExtensions({ tasksEnabled: true });
		worker.tasks.setEnabled(true);
		expect(worker.tasks.enabled).toBe(false);
		const run = vi.fn();
		await expect(
			worker.tasks.execute({ kind: "bash", title: "no", toolCallId: "no", background: true, run }),
		).rejects.toThrow("not permitted in this host");
		expect(run).not.toHaveBeenCalled();
		await worker.reload();
		worker.tasks.setEnabled(true);
		expect(worker.tasks.enabled).toBe(false);
		const foreground = await worker.tasks.execute({
			kind: "custom",
			title: "inline",
			toolCallId: "inline",
			run: async () => ({ result: { content: [], details: undefined } }),
		});
		expect(foreground.kind).toBe("result");
	});

	it("settles usage before consumption and schedules a bounded persisted notification", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const resume = session.pauseTaskNotifications();
		const entries: string[] = [];
		const snapshotAvailable: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom") entries.push(event.entry.customType);
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === TASK_USAGE_TYPE
			)
				snapshotAvailable.push(
					session.sessionManager
						.getEntries()
						.some((entry) => entry.type === "custom" && entry.customType === "task-result"),
				);
		});
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		expect(entries).toEqual([TASK_USAGE_TYPE, "task-result"]);
		expect(snapshotAvailable).toEqual([true]);
		expect(session.getSessionStats().tokens.total).toBe(30);
		expect(session.messages).toHaveLength(0);
		resume();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		const notifications = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(notifications).toHaveLength(1);
		const notification = notifications[0];
		if (notification.type !== "custom_message") throw new Error("expected notification");
		expect(notification.customType).toBe("task-completion");
		expect(notification.details).toMatchObject({
			version: 2,
			taskId: execution.id,
			kind: "custom",
			status: "completed",
			startedAt: expect.any(Number),
			endedAt: expect.any(Number),
		});
		expect(Buffer.byteLength(String(notification.content))).toBeLessThanOrEqual(48 * 1024);
		expect(session.tasks.pendingNotifications()).toHaveLength(0);
		await session.tasks.read(execution.id);
		await session.tasks.wait(execution.id, 0);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === TASK_USAGE_TYPE),
		).toHaveLength(1);
	});

	it.each(["malformed", "foreign", "running", "foreground"] as const)(
		"does not acknowledge a %s outcome marker",
		async (mode) => {
			let marker: unknown;
			const session = await host(
				true,
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
			await session.bindExtensions({ tasksEnabled: true });
			session.pauseTaskNotifications();
			const execution = await task(session);
			marker = mode === "malformed" ? 42 : mode === "foreign" ? "custom-foreign" : execution.id;
			if (mode === "foreground") {
				await session.tasks.execute({
					kind: "bash",
					title: "foreground",
					toolCallId: "foreground",
					run: async () => ({ result: { content: [], details: undefined } }),
				});
				marker = session.tasks.list().find((task) => task.mode === "foreground")!.id;
			}
			const delivered = vi.spyOn(session.tasks, "markDelivered");
			await session.prompt("marker");
			expect(delivered).not.toHaveBeenCalled();
			execution.finish();
		},
	);

	it.each(["persist", "abort", "remove-marker"] as const)(
		"coordinates terminal wait delivery at persistence: %s",
		async (mode) => {
			let id = "";
			const waitArgs = { action: "wait", taskId: "" };
			let releaseRead!: () => void;
			const readGate = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
			let readStarted!: () => void;
			const reading = new Promise<void>((resolve) => {
				readStarted = resolve;
			});
			const session = await host(
				true,
				(pi) => {
					if (mode === "remove-marker") {
						pi.on("tool_result", () => ({ details: {} }));
					}
				},
				[
					{
						...fauxAssistantMessage(""),
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "wait-1", name: "tasks", arguments: waitArgs }],
					},
					fauxAssistantMessage("finished"),
					fauxAssistantMessage("noticed"),
				],
			);
			await session.bindExtensions({ tasksEnabled: true });
			const execution = await task(session);
			id = execution.id;
			waitArgs.taskId = id;
			const read = session.tasks.read.bind(session.tasks);
			vi.spyOn(session.tasks, "read").mockImplementation(async (...args) => {
				readStarted();
				await readGate;
				return read(...args);
			});
			const delivered = vi.spyOn(session.tasks, "markDelivered");
			const append = session.sessionManager.appendMessage.bind(session.sessionManager);
			vi.spyOn(session.sessionManager, "appendMessage").mockImplementation((message) => {
				if (message.role === "toolResult") expect(delivered).not.toHaveBeenCalled();
				return append(message);
			});
			const prompting = session.prompt("wait for task");
			execution.finish();
			await reading;
			expect(session.tasks.get(id).status).toBe("completed");
			expect(delivered).not.toHaveBeenCalled();
			expect(session.messages.some((message) => message.role === "custom")).toBe(false);
			// Abort deterministically after core wait resolved, while output read is pending.
			if (mode === "abort") session.agent.abort();
			releaseRead();
			await prompting;
			if (mode === "abort") {
				await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
				await session.waitForIdle();
			} else {
				expect(session.messages.some((message) => message.role === "custom")).toBe(false);
				const result = session.messages.find((message) => message.role === "toolResult");
				if (mode === "persist")
					expect(result?.role === "toolResult" && result.details).toMatchObject({ taskId: id });
				else expect(result?.role === "toolResult" && result.details).toEqual({});
			}
			expect(delivered).toHaveBeenCalledExactlyOnceWith(id);
			expect(session.tasks.pendingNotifications()).toEqual([]);
		},
	);

	it("restores completed snapshots on startup and reload without execution, notification, or double accounting", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const resume = session.pauseTaskNotifications();
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		const before = session.sessionManager.getEntries();
		await session.reload();
		await session.reload();
		expect(session.tasks.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		expect(session.tasks.pendingNotifications()).toEqual([]);
		expect(session.sessionManager.getEntries()).toEqual(before);
		expect(session.getSessionStats().tokens.total).toBe(30);
		resume();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.messages).toEqual([]);
		const restored = await host(true, undefined, undefined, session.sessionManager);
		expect(restored.tasks.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		expect(restored.getSessionStats().tokens.total).toBe(30);
		expect(restored.tasks.pendingNotifications()).toEqual([]);
	});

	it("restores only valid current-branch envelopes and merges tree history without duplicate IDs", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		session.pauseTaskNotifications();
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		const resultLeaf = session.sessionManager.getLeafId()!;
		const snapshot = session.tasks.get(execution.id);
		await session.navigateTree(root);
		await session.reload();
		expect(session.tasks.list()).toEqual([]);
		const invalid = [null, { version: 1, task: snapshot }, { version: 2, task: { ...snapshot, status: "running" } }];
		for (const record of invalid) session.sessionManager.appendCustomEntry("task-result", record);
		session.sessionManager.appendCustomEntry("unrelated", { version: 1, task: snapshot });
		await session.reload();
		expect(session.tasks.list()).toEqual([]);
		await session.navigateTree(resultLeaf);
		expect(session.tasks.list()).toMatchObject([{ id: execution.id, status: "completed" }]);
		session.sessionManager.appendMessage(userMsg("later"));
		await session.navigateTree(resultLeaf);
		expect(session.tasks.list()).toHaveLength(1);
		expect(session.tasks.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
	});

	it("saves foreground output once, in its tool result, and restores it from there", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const output = [{ type: "text" as const, text: "foreground output" }];
		const outcome = await session.tasks.execute({
			kind: "bash",
			title: "echo",
			command: "echo foreground output",
			toolCallId: "call-foreground",
			run: async (control) => {
				control.accept();
				return { result: { content: output, details: undefined }, exitCode: 0 };
			},
		});
		expect(outcome.kind).toBe("result");
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-foreground",
			toolName: "bash",
			content: output,
			isError: false,
			timestamp: Date.now(),
		});
		const saved = session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === "task-result" ? [entry.data] : []));
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({ task: { command: "echo foreground output", exitCode: 0 } });
		expect(saved[0]).not.toHaveProperty("task.result");

		await session.reload();
		const [restored] = session.tasks.list();
		expect(restored).toMatchObject({ mode: "foreground", status: "completed", command: "echo foreground output" });
		expect(restored?.result?.content).toEqual(output);
		expect((await session.tasks.read(restored!.id)).text).toBe("foreground output");
	});

	it("lists the running tasks that a tree navigation would stop", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		session.pauseTaskNotifications();
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const launch = session.sessionManager.appendMessage(userMsg("launch"));
		const execution = await task(session);
		const later = session.sessionManager.appendMessage(userMsg("later"));
		// Selecting a user message moves the leaf to its parent.
		expect(session.tasksStoppedByTreeNavigation(later)).toEqual([]);
		expect(session.tasksStoppedByTreeNavigation(launch).map((task) => task.id)).toEqual([execution.id]);
		expect(session.tasksStoppedByTreeNavigation(root).map((task) => task.id)).toEqual([execution.id]);
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		expect(session.tasksStoppedByTreeNavigation(root)).toEqual([]);
	});

	it("caps restored history at the runtime terminal-history limit", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		session.pauseTaskNotifications();
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		const snapshot = session.tasks.get(execution.id);
		for (let index = 0; index < 40; index++) {
			session.sessionManager.appendCustomEntry("task-result", {
				version: 2,
				task: { ...snapshot, id: `custom-history-${index}`, endedAt: snapshot.endedAt! + index + 1 },
			});
		}
		await session.reload();
		expect(session.tasks.list()).toHaveLength(32);
		expect(session.tasks.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
	});

	it("allows completion turns while an observer command remains open", async () => {
		let close!: () => void;
		let opened = false;
		const panel = new Promise<void>((resolve) => {
			close = resolve;
		});
		const session = await host(true, (pi) => {
			pi.registerCommand("observer", {
				handler: async () => {
					opened = true;
					await panel;
				},
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
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
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		const service = session.tasks;
		const shutdown = service.shutdown.bind(service);
		vi.spyOn(service, "shutdown").mockImplementation(() => shutdown(0));
		await session.reload();
		const leaf = session.sessionManager.appendMessage(userMsg("new generation"));
		const count = session.sessionManager.getEntries().length;
		expect(execution.control.signal.aborted).toBe(true);
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedTaskSettlements).toHaveLength(1));
		expect(session.quarantinedTaskSettlements[0]).toMatchObject({ task: { id: execution.id }, usage });
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		expect(session.tasks.list()).toHaveLength(0);
		expect(session.messages).toHaveLength(0);
	});

	it("quarantines ignored-abort settlement after tree navigation", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		session.sessionManager.appendMessage(userMsg("next"));
		await session.navigateTree(root);
		expect(execution.control.signal.aborted).toBe(true);
		const count = session.sessionManager.getEntries().length;
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedTaskSettlements).toHaveLength(1));
		expect(session.quarantinedTaskSettlements[0].usage).toEqual(usage);
		expect(session.sessionManager.getLeafId()).toBeNull();
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		expect(session.messages).toHaveLength(0);
	}, 10_000);

	it("keeps late usage out of a reused in-memory session manager", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		session.dispose();
		session.sessionManager.newSession();
		execution.finish();
		await vi.waitFor(() => expect(session.quarantinedTaskSettlements).toHaveLength(1));
		expect(session.sessionManager.getEntries()).toHaveLength(0);
		expect(session.quarantinedTaskSettlements[0].usage).toEqual(usage);
	});

	it("bounds late snapshots and diagnoses unpersisted usage even when diagnostics throw", async () => {
		const session = await host();
		const warning = vi.fn((_error: { event?: string; error: string }) => {
			throw new Error("observer failed");
		});
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		let lastId = "";
		for (let batch = 0; batch < 5; batch++) {
			const executions = await Promise.all(Array.from({ length: batch === 4 ? 1 : 8 }, () => task(session)));
			const service = session.tasks;
			const shutdown = service.shutdown.bind(service);
			vi.spyOn(service, "shutdown").mockImplementation(() => shutdown(0));
			await session.reload();
			for (const execution of executions) execution.finish();
			await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(Math.min((batch + 1) * 8, 33)));
			lastId = executions.at(-1)!.id;
		}
		expect(session.quarantinedTaskSettlements).toHaveLength(32);
		expect(session.quarantinedTaskSettlements.at(-1)?.task.id).toBe(lastId);
		expect(warning.mock.calls.at(-1)?.[0]).toMatchObject({
			event: "task_settlement_quarantined",
			error: expect.stringContaining("Not persisted"),
		});
		expect(session.sessionManager.getEntries()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(0);
	});

	it("reports sidecar persistence failure without writing to the active session", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
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
					event: "task_settlement_quarantined",
					error: expect.stringContaining("Sidecar write failed. Not persisted"),
				}),
			),
		);
		expect(session.quarantinedTaskSettlements).toHaveLength(1);
		expect(session.sessionManager.getEntries()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(0);
	});

	it("contains escaped scheduled drain failures and cleanup warnings", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		const pending = vi.spyOn(session.tasks, "pendingNotifications").mockImplementation(() => {
			throw new Error("observer escaped");
		});
		session.retryTaskNotifications();
		await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })));
		pending.mockRestore();
		await session.tasks.execute({
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
		await session.tasks.shutdown();
		const cleanup = warning.mock.calls.find(([error]) => error.event === "task_cleanup")?.[0];
		expect(cleanup).toBeDefined();
		expect(Buffer.byteLength(cleanup.error)).toBeLessThanOrEqual(4096);
	});

	it("gives user preflight priority and never injects while input hooks are pending", async () => {
		let acceptInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			acceptInput = resolve;
		});
		const session = await host(true, (pi) => {
			pi.on("input", async () => {
				await inputGate;
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		const prompting = session.prompt("user request");
		execution.finish();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.messages).toHaveLength(0);
		acceptInput();
		await prompting;
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		// The transcript's system message precedes the conversation; the user's input must come next.
		expect(session.messages.find((message) => message.role !== "system")?.role).toBe("user");
	});

	it("steers a completion into the active run after the complete main tool batch", async () => {
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolStarted = false;
		let inSettledHook = false;
		let runs = 0;
		const session = await host(
			true,
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
					runs++;
					expect(inSettledHook).toBe(false);
				});
			},
			[
				{
					...fauxAssistantMessage(""),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }],
				},
				fauxAssistantMessage("background noticed"),
			],
		);
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		const steer = vi.spyOn(session.agent, "steer");
		const prompting = session.prompt("run tool");
		await vi.waitFor(() => expect(toolStarted).toBe(true));
		execution.finish();
		await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
		expect(steer.mock.calls[0]?.[0]).toMatchObject({ role: "custom", customType: "task-completion" });
		// The completion waits for the batch, so nothing is injected while the tool is still running.
		expect(session.messages.some((message) => message.role === "custom")).toBe(false);
		releaseTool();
		await prompting;
		await session.waitForIdle();
		const roles = session.messages.map((message) => message.role);
		expect(roles.indexOf("custom")).toBeGreaterThan(roles.indexOf("toolResult"));
		// Steering keeps the completion inside the run that was already active: no new turn.
		expect(runs).toBe(1);
		expect(session.tasks.pendingNotifications()).toEqual([]);
	});

	it("keeps a completion claimed while it waits in the steering queue for the next run", async () => {
		let calls = 0;
		const session = await host(true, undefined, undefined, SessionManager.inMemory(), (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			calls++;
			queueMicrotask(() => stream.push({ type: "start", partial: fauxAssistantMessage("") }));
			if (calls > 1) {
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("noticed") }),
				);
				return stream;
			}
			// Hold the first response open until the run is aborted, so the queued completion is
			// never drained by this run.
			const watch = () => {
				if (options?.signal?.aborted) {
					stream.push({
						type: "error",
						reason: "aborted",
						error: fauxAssistantMessage("Aborted", { stopReason: "aborted" }),
					});
					return;
				}
				setTimeout(watch, 5);
			};
			watch();
			return stream;
		});
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		const prompting = session.prompt("hold the run");
		execution.finish();
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		// Aborting leaves the message queued instead of injected, so its claim stays alive rather
		// than being released for a retry that would persist the same completion twice.
		await session.abort();
		await prompting;
		expect(session.messages.some((message) => message.role === "custom")).toBe(false);
		expect(session.tasks.pendingNotifications()).toEqual([]);
		await session.prompt("next");
		await session.waitForIdle();
		const roles = session.messages.map((message) => message.role);
		expect(roles.filter((role) => role === "custom")).toHaveLength(1);
		expect(roles.indexOf("custom")).toBeGreaterThan(roles.lastIndexOf("user"));
		expect(session.tasks.pendingNotifications()).toEqual([]);
	});

	it("releases a completion the run emitted but never persisted", async () => {
		let toolStarted = false;
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const session = await host(
			true,
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
			},
			[
				{
					...fauxAssistantMessage(""),
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "hold-1", name: "hold", arguments: {} }],
				},
				fauxAssistantMessage("background noticed"),
			],
		);
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		const append = session.sessionManager.appendCustomMessageEntry.bind(session.sessionManager);
		const persist = vi.spyOn(session.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
			if (args[0] === "task-completion") throw new Error("persistence failed");
			return append(...args);
		});
		const execution = await task(session);
		const prompting = session.prompt("run tool");
		await vi.waitFor(() => expect(toolStarted).toBe(true));
		execution.finish();
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		releaseTool();
		// The run drains the queued completion and fails to persist it, so no later run can
		// deliver it: the claim is released instead of waiting for a message that never lands.
		await prompting;
		await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })));
		expect(session.tasks.pendingNotifications()).toHaveLength(1);
		persist.mockRestore();
		session.retryTaskNotifications();
		const delivered = vi.spyOn(session.tasks, "markDelivered");
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(execution.id));
		expect(session.tasks.pendingNotifications()).toEqual([]);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it.each(["reject", "drop"] as const)(
		"does not timer-retry a %s delivery without explicit host retry",
		async (mode) => {
			const session = await host();
			const warning = vi.fn();
			await session.bindExtensions({ tasksEnabled: true, onError: warning });
			// Delivery failure = the triggered turn rejects, or settles without persisting
			// the claimed message. Both leave the claim alive for the drain's finally.
			const deliver = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
				if (mode === "reject") throw new Error("persistence failed");
			});
			const execution = await task(session);
			execution.finish();
			await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
			await vi.waitFor(() =>
				expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })),
			);
			session.tasks.setEnabled(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deliver).toHaveBeenCalledOnce();
			expect(session.tasks.pendingNotifications()).toHaveLength(1);
			deliver.mockRestore();
			session.retryTaskNotifications();
			await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
			await session.waitForIdle();
			expect(session.tasks.pendingNotifications()).toHaveLength(0);
		},
	);

	it("retries a failed completion delivery on the next user prompt", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		const deliver = vi.spyOn(session.agent, "prompt").mockRejectedValueOnce(new Error("persistence failed"));
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })));
		expect(session.tasks.pendingNotifications()).toHaveLength(1);
		deliver.mockRestore();
		await session.prompt("next");
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		expect(session.tasks.pendingNotifications()).toEqual([]);
	});

	it("keeps a completion pending without a model instead of failure-marking it", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		const prompting = vi.spyOn(session.agent, "prompt");
		const model = session.agent.state.model;
		session.agent.state.model = undefined as never;
		try {
			const execution = await task(session);
			execution.finish();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(session.tasks.pendingNotifications()).toHaveLength(1);
			expect(prompting).not.toHaveBeenCalled();
			expect(warning).not.toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" }));
			session.agent.state.model = model;
			session.retryTaskNotifications();
			await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
			await session.waitForIdle();
			expect(session.tasks.pendingNotifications()).toEqual([]);
		} finally {
			session.agent.state.model = model;
		}
	});

	it("carries pending nextTurn messages into the completion turn", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		await session.sendCustomMessage(
			{ customType: "aside", content: "queued context", display: false },
			{ deliverAs: "nextTurn" },
		);
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() =>
			expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2),
		);
		await session.waitForIdle();
		const customTypes = session.sessionManager
			.getEntries()
			.map((entry) => (entry.type === "custom_message" ? entry.customType : undefined))
			.filter((customType) => customType !== undefined);
		expect(customTypes).toEqual(["task-completion", "aside"]);
		expect(session.tasks.pendingNotifications()).toEqual([]);
	});

	it("retains nextTurn context when a completion turn fails before persistence", async () => {
		const session = await host();
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		await session.sendCustomMessage(
			{ customType: "aside", content: "queued context", display: false },
			{ deliverAs: "nextTurn" },
		);
		const prompt = vi.spyOn(session.agent, "prompt").mockRejectedValueOnce(new Error("delivery failed"));
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })));
		prompt.mockRestore();
		session.retryTaskNotifications();
		await vi.waitFor(() =>
			expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2),
		);
		await session.waitForIdle();
		expect(
			session.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : [])),
		).toEqual(["task-completion", "aside"]);
	});

	it("retries only nextTurn context that was not persisted during a partial delivery", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		for (const customType of ["first-aside", "second-aside"]) {
			await session.sendCustomMessage(
				{ customType, content: customType, display: false },
				{ deliverAs: "nextTurn" },
			);
		}
		const append = session.sessionManager.appendCustomMessageEntry.bind(session.sessionManager);
		const persist = vi.spyOn(session.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
			if (args[0] === "second-aside") throw new Error("persistence failed");
			return append(...args);
		});
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(persist.mock.calls.some(([type]) => type === "second-aside")).toBe(true));
		await session.waitForIdle();
		expect(session.tasks.pendingNotifications()).toEqual([]);
		persist.mockRestore();
		await session.prompt("continue");
		expect(
			session.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : [])),
		).toEqual(["task-completion", "first-aside", "second-aside"]);
	});

	it("acknowledges the original notification when an extension role rewrite is rejected", async () => {
		const session = await host(true, (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role === "custom" && event.message.customType === "task-completion")
					return { message: { role: "user", content: event.message.content, timestamp: Date.now() } };
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		const delivered = vi.spyOn(session.tasks, "markDelivered");
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(execution.id));
		await session.waitForIdle();
		expect(session.tasks.pendingNotifications()).toEqual([]);
	});

	it("acknowledges a persisted notification even when extensions replace its metadata", async () => {
		const session = await host(true, (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role === "custom")
					return { message: { ...event.message, details: undefined, customType: "transformed" } };
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		const execution = await task(session);
		execution.finish();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		expect(session.tasks.pendingNotifications()).toHaveLength(0);
		session.retryTaskNotifications();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("closes captured service synchronously on dispose", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const service = session.tasks;
		const execution = await task(session);
		session.dispose();
		expect(execution.control.signal.aborted).toBe(true);
		expect(service.enabled).toBe(false);
		execution.finish();
	});

	it("settles cooperative workers and their ledger before extension shutdown hooks", async () => {
		let ledgerAtShutdown = false;
		const session = await host(true, (pi) => {
			pi.on("session_shutdown", (_event, ctx) => {
				ledgerAtShutdown = ctx.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === TASK_USAGE_TYPE);
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		await session.tasks.execute({
			kind: "custom",
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
		expect(session.tasks.list()).toMatchObject([{ status: "cancelled" }]);
		expect(session.tasks.pendingNotifications()).toEqual([]);
		expect(session.getSessionStats().tokens.total).toBe(30);
		expect(session.messages).toHaveLength(0);
	});

	it("reload closes admission before async cleanup and replaces captured capability", async () => {
		let shutdownEnabled: boolean | undefined;
		const session = await host(true, (pi) => {
			pi.on("session_shutdown", (_event, ctx) => {
				shutdownEnabled = ctx.tasks.enabled;
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		const service = session.tasks;
		const ctx = session.extensionRunner.createContext();
		const reloading = session.reload();
		expect(service.enabled).toBe(false);
		await reloading;
		expect(shutdownEnabled).toBe(false);
		expect(session.tasks).not.toBe(service);
		expect(session.tasks.enabled).toBe(true);
		expect(() => ctx.tasks).toThrow("stale");
	});

	it("tree uses the destination parent path, including explicit root", async () => {
		const session = await host();
		await session.bindExtensions({ tasksEnabled: true });
		const root = session.sessionManager.appendMessage(userMsg("root"));
		const execution = await task(session);
		const cancel = vi.spyOn(session.tasks, "cancelOutsideBranch").mockImplementation(async (ancestors) => {
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

	/** An extension hook that parks inside a lifecycle operation until released. */
	function hookGate() {
		let entered!: () => void;
		let release!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			armed: false,
			reached,
			release,
			async hold() {
				entered();
				await released;
			},
		};
	}

	function deliveredCompletions(session: AgentSession): number {
		return session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length;
	}

	/** A completion that finishes while `gate` holds the operation open must land only after it. */
	async function expectCompletionHeldAcross(
		session: AgentSession,
		gate: ReturnType<typeof hookGate>,
		operation: () => Promise<unknown>,
	) {
		const execution = await task(session);
		gate.armed = true;
		const running = operation();
		await gate.reached;
		execution.finish();
		await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(deliveredCompletions(session)).toBe(0);
		gate.release();
		await running;
		await vi.waitFor(() => expect(deliveredCompletions(session)).toBe(1));
		await session.waitForIdle();
	}

	it("holds completions while extension binding runs its session_start hooks", async () => {
		const gate = hookGate();
		const session = await host(true, (pi) => {
			pi.on("session_start", async () => {
				if (gate.armed) await gate.hold();
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		await expectCompletionHeldAcross(session, gate, () => session.bindExtensions({}));
	});

	it("holds completions while agent_settled hooks run after a turn", async () => {
		const gate = hookGate();
		const session = await host(true, (pi) => {
			pi.on("agent_settled", async () => {
				if (gate.armed) await gate.hold();
			});
		});
		await session.bindExtensions({ tasksEnabled: true });
		await expectCompletionHeldAcross(session, gate, () => session.prompt("user request"));
		const roles = session.messages.filter((message) => message.role !== "system").map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "custom", "assistant"]);
	});
});
