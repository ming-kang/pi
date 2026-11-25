import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TaskCompletion, TaskControl, TaskRead, TaskSnapshot } from "../src/core/tasks/types.ts";
import tasksExtension from "../src/extensions/tasks/index.ts";
import { RpcClient, type RpcEvent } from "../src/modes/rpc/rpc-client.ts";
import { type RpcTaskLifecycleEvent, runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/rpc/jsonl.ts")>();
	return {
		...actual,
		attachJsonlLineReader: vi.fn((stream: Readable, onLine: (line: string) => void) => {
			if (stream === (process.stdin as unknown as Readable)) {
				rpcIo.lineHandler = onLine;
				return () => {
					rpcIo.lineHandler = undefined;
				};
			}
			return actual.attachJsonlLineReader(stream, onLine);
		}),
	};
});

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(): ParsedOutputLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getLifecycleEvents(): RpcTaskLifecycleEvent[] {
	return parseOutputLines().filter(
		(line): line is ParsedOutputLine & RpcTaskLifecycleEvent => line.type === "task_lifecycle",
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function createSession(
	extensionsResult?: LoadExtensionsResult,
	maxBackground?: number,
): Promise<{
	tempDir: string;
	session: AgentSession;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	if (maxBackground !== undefined) {
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ tasks: { maxBackground } }));
	}

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});

	return { tempDir, session };
}

async function startRpcMode(options?: { maxBackground?: number }): Promise<{
	tempDir: string;
	session: AgentSession;
	runtimeHost: AgentSessionRuntime;
	rebindSession: () => Promise<void>;
	sendCommand: (command: Record<string, unknown>) => Promise<ParsedOutputLine>;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const listenerSnapshot = takeListenerSnapshot();
	const extensionsResult = await createTestExtensionsResult([tasksExtension]);
	const { tempDir, session } = await createSession(extensionsResult, options?.maxBackground);
	const extraSessions: Array<{ tempDir: string; session: AgentSession }> = [];

	let rebindCallback: ((session: AgentSession) => Promise<void>) | undefined;
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => {
			const next = await createSession(await createTestExtensionsResult([tasksExtension]));
			extraSessions.push(next);
			runtimeHost.session = next.session;
			await rebindCallback?.(next.session);
			return { cancelled: false };
		}),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		takeUnreportedDiagnostics: vi.fn(() => []),
		setRebindSession: vi.fn((fn: (session: AgentSession) => Promise<void>) => {
			rebindCallback = fn;
		}),
	} as unknown as AgentSessionRuntime & { session: AgentSession };

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	let seq = 0;
	const sendCommand = async (command: Record<string, unknown>): Promise<ParsedOutputLine> => {
		const id = `cmd-${++seq}`;
		rpcIo.lineHandler!(JSON.stringify({ ...command, id }));
		let response: ParsedOutputLine | undefined;
		await vi.waitFor(() => {
			response = parseOutputLines().find((line) => line.type === "response" && line.id === id);
			expect(response).toBeDefined();
		});
		return response!;
	};

	return {
		tempDir,
		session,
		runtimeHost,
		rebindSession: async () => {
			await rebindCallback?.(runtimeHost.session);
		},
		sendCommand,
		cleanup: async () => {
			for (const s of [session, ...extraSessions.map((entry) => entry.session)]) {
				try {
					await s.shutdownTasks();
				} catch {
					// ignore test cleanup failures
				}
				try {
					await s.abort();
				} catch {
					// ignore test cleanup failures
				}
				s.dispose();
			}
			for (const dir of [tempDir, ...extraSessions.map((entry) => entry.tempDir)]) {
				if (existsSync(dir)) {
					rmSync(dir, { recursive: true, force: true });
				}
			}
			restoreListeners(listenerSnapshot);
		},
	};
}

describe("RPC mode tasks", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
	});

	it("supports list_tasks, get_task, and read_task including filter and unknown task errors", async () => {
		const { tempDir, session, sendCommand, cleanup } = await startRpcMode();

		try {
			const emptyList = await sendCommand({ type: "list_tasks" });
			expect(emptyList).toMatchObject({
				type: "response",
				command: "list_tasks",
				success: true,
				data: { tasks: [] },
			});

			const logPath = join(tempDir, "task-output.log");
			writeFileSync(
				logPath,
				["line 1: boot", "line 2: setup", "line 3: ERROR failed check", "line 4: cleanup", "line 5: done"].join(
					"\n",
				),
			);

			const gate = deferred<TaskCompletion<undefined>>();
			let control!: TaskControl<undefined>;
			const outcome = await session.tasks.execute({
				kind: "custom",
				title: "File-backed background task",
				toolCallId: "tool-read-1",
				background: true,
				run: (next) => {
					control = next;
					next.attachOutput(logPath);
					next.accept();
					return gate.promise;
				},
			});
			expect(outcome.kind).toBe("background");

			const listRes = await sendCommand({ type: "list_tasks" });
			expect(listRes.success).toBe(true);
			const listedTasks = (listRes.data as { tasks: TaskSnapshot[] }).tasks;
			expect(listedTasks).toHaveLength(1);
			expect(listedTasks[0]!.id).toBe(control.id);
			expect(listedTasks[0]!.mode).toBe("background");
			expect(listedTasks[0]!.status).toBe("running");

			const getExact = await sendCommand({ type: "get_task", taskId: control.id });
			expect(getExact).toMatchObject({
				success: true,
				command: "get_task",
				data: { task: { id: control.id, title: "File-backed background task" } },
			});

			const shortPrefix = control.id.slice("custom-".length, "custom-".length + 6);
			const getPrefix = await sendCommand({ type: "get_task", taskId: shortPrefix });
			expect(getPrefix).toMatchObject({
				success: true,
				command: "get_task",
				data: { task: { id: control.id } },
			});

			const unknownGet = await sendCommand({ type: "get_task", taskId: "nonexistent-task" });
			expect(unknownGet).toMatchObject({
				type: "response",
				command: "get_task",
				success: false,
				error: "Unknown task ID",
			});

			const headRead = await sendCommand({
				type: "read_task",
				taskId: control.id,
				mode: "head",
				bytes: 12,
			});
			expect(headRead.success).toBe(true);
			const headData = headRead.data as TaskRead;
			expect(headData.text).toBe("line 1: boot");
			expect(headData.fromByte).toBe(0);
			expect(headData.truncated).toBe(true);

			const sinceRead = await sendCommand({
				type: "read_task",
				taskId: control.id,
				mode: "head",
				sinceBytes: 13,
				endByte: 26,
			});
			expect(sinceRead.success).toBe(true);
			expect((sinceRead.data as TaskRead).text).toBe("line 2: setup");

			const filteredRead = await sendCommand({
				type: "read_task",
				taskId: control.id,
				filter: "error",
				contextLines: 1,
			});
			expect(filteredRead.success).toBe(true);
			const filteredData = filteredRead.data as TaskRead;
			expect(filteredData.filtered).toBe(true);
			expect(filteredData.totalMatches).toBe(1);
			expect(filteredData.text).toBe("2- line 2: setup\n3: line 3: ERROR failed check\n4- line 4: cleanup");

			const unknownRead = await sendCommand({ type: "read_task", taskId: "missing-id" });
			expect(unknownRead).toMatchObject({
				type: "response",
				command: "read_task",
				success: false,
				error: "Unknown task ID",
			});

			gate.resolve({ result: { content: [{ type: "text", text: "ok" }], details: undefined } });
		} finally {
			await cleanup();
		}
	});

	it("kills a running background task via kill_task", async () => {
		const { session, sendCommand, cleanup } = await startRpcMode();

		try {
			const settled = deferred<void>();
			let control!: TaskControl<undefined>;
			const outcome = await session.tasks.execute({
				kind: "custom",
				title: "Killable task",
				toolCallId: "tool-kill-1",
				background: true,
				run: (next) => {
					control = next;
					next.accept();
					return new Promise<TaskCompletion<undefined>>((resolve) => {
						next.signal.addEventListener(
							"abort",
							() => {
								resolve({ result: { content: [{ type: "text", text: "aborted" }], details: undefined } });
								settled.resolve();
							},
							{ once: true },
						);
					});
				},
			});
			expect(outcome.kind).toBe("background");

			const killRes = await sendCommand({ type: "kill_task", taskId: control.id });
			expect(killRes.success).toBe(true);
			const killData = killRes.data as { requested: boolean; task: TaskSnapshot };
			expect(killData.requested).toBe(true);
			expect(["stopping", "cancelled"]).toContain(killData.task.status);
			expect(control.signal.aborted).toBe(true);

			await settled.promise;
			await vi.waitFor(async () => {
				const state = await sendCommand({ type: "get_task", taskId: control.id });
				expect((state.data as { task: TaskSnapshot }).task.status).toBe("cancelled");
			});

			const secondKill = await sendCommand({ type: "kill_task", taskId: control.id });
			expect(secondKill).toMatchObject({
				success: true,
				command: "kill_task",
				data: { requested: false, task: { id: control.id, status: "cancelled" } },
			});

			const unknownKill = await sendCommand({ type: "kill_task", taskId: "unknown-kill" });
			expect(unknownKill).toMatchObject({
				success: false,
				command: "kill_task",
				error: "Unknown task ID",
			});
		} finally {
			await cleanup();
		}
	});

	it("detaches a specific foreground task and all foreground tasks via detach_tasks", async () => {
		const { session, sendCommand, cleanup } = await startRpcMode();

		try {
			const gate1 = deferred<TaskCompletion<undefined>>();
			const gate2 = deferred<TaskCompletion<undefined>>();
			const gate3 = deferred<TaskCompletion<undefined>>();
			let control1!: TaskControl<undefined>;
			let control2!: TaskControl<undefined>;
			let control3!: TaskControl<undefined>;

			const call1 = session.tasks.execute({
				kind: "custom",
				title: "FG task 1",
				toolCallId: "fg-1",
				run: (next) => {
					control1 = next;
					next.accept();
					return gate1.promise;
				},
			});
			const call2 = session.tasks.execute({
				kind: "custom",
				title: "FG task 2",
				toolCallId: "fg-2",
				run: (next) => {
					control2 = next;
					next.accept();
					return gate2.promise;
				},
			});
			const call3 = session.tasks.execute({
				kind: "custom",
				title: "FG task 3",
				toolCallId: "fg-3",
				run: (next) => {
					control3 = next;
					next.accept();
					return gate3.promise;
				},
			});

			const detachOne = await sendCommand({ type: "detach_tasks", taskId: control1.id });
			expect(detachOne).toEqual({
				id: detachOne.id,
				type: "response",
				command: "detach_tasks",
				success: true,
				data: { detached: 1 },
			});
			await expect(call1).resolves.toMatchObject({ kind: "background", reason: "detached" });
			expect(session.tasks.get(control1.id).mode).toBe("background");
			expect(session.tasks.get(control2.id).mode).toBe("foreground");
			expect(session.tasks.get(control3.id).mode).toBe("foreground");

			const detachAlreadyBg = await sendCommand({ type: "detach_tasks", taskId: control1.id });
			expect(detachAlreadyBg).toMatchObject({
				success: true,
				command: "detach_tasks",
				data: { detached: 0 },
			});

			const detachAll = await sendCommand({ type: "detach_tasks" });
			expect(detachAll).toMatchObject({
				success: true,
				command: "detach_tasks",
				data: { detached: 2 },
			});
			await expect(call2).resolves.toMatchObject({ kind: "background", reason: "detached" });
			await expect(call3).resolves.toMatchObject({ kind: "background", reason: "detached" });

			const detachNone = await sendCommand({ type: "detach_tasks" });
			expect(detachNone).toMatchObject({
				success: true,
				command: "detach_tasks",
				data: { detached: 0 },
			});

			const detachUnknown = await sendCommand({ type: "detach_tasks", taskId: "missing-detach" });
			expect(detachUnknown).toMatchObject({
				success: false,
				command: "detach_tasks",
				error: "Unknown task ID",
			});

			const doneResult = { content: [{ type: "text" as const, text: "done" }], details: undefined };
			gate1.resolve({ result: doneResult });
			gate2.resolve({ result: doneResult });
			gate3.resolve({ result: doneResult });
		} finally {
			await cleanup();
		}
	});

	it("returns an RPC error when detach_tasks exceeds maxBackground limit", async () => {
		const { session, sendCommand, cleanup } = await startRpcMode({ maxBackground: 1 });

		try {
			const bgGate = deferred<TaskCompletion<undefined>>();
			const fgGate = deferred<TaskCompletion<undefined>>();
			let fgControl!: TaskControl<undefined>;

			await session.tasks.execute({
				kind: "custom",
				title: "Existing BG task",
				toolCallId: "bg-limit-1",
				background: true,
				run: (next) => {
					next.accept();
					return bgGate.promise;
				},
			});
			const fgCall = session.tasks.execute({
				kind: "custom",
				title: "FG task blocked on limit",
				toolCallId: "fg-limit-2",
				run: (next) => {
					fgControl = next;
					next.accept();
					return fgGate.promise;
				},
			});

			const detachErr = await sendCommand({ type: "detach_tasks", taskId: fgControl.id });
			expect(detachErr).toMatchObject({
				success: false,
				command: "detach_tasks",
				error: expect.stringContaining("Background task limit reached (1)"),
			});

			const doneResult = { content: [{ type: "text" as const, text: "done" }], details: undefined };
			bgGate.resolve({ result: doneResult });
			fgGate.resolve({ result: doneResult });
			await fgCall;
		} finally {
			await cleanup();
		}
	});

	it("emits task_lifecycle events only when subscribed via subscribe_tasks", async () => {
		const { session, sendCommand, cleanup } = await startRpcMode();

		try {
			const gateDefault = deferred<TaskCompletion<undefined>>();
			let ctrlDefault!: TaskControl<undefined>;
			await session.tasks.execute({
				kind: "custom",
				title: "Unsubscribed task",
				toolCallId: "unsub-1",
				background: true,
				run: (next) => {
					ctrlDefault = next;
					next.accept();
					return gateDefault.promise;
				},
			});
			ctrlDefault.publish({ result: { content: [{ type: "text", text: "progress" }], details: undefined } });
			gateDefault.resolve({ result: { content: [{ type: "text", text: "done" }], details: undefined } });
			await vi.waitFor(() => expect(session.tasks.get(ctrlDefault.id).status).toBe("completed"));
			expect(getLifecycleEvents()).toEqual([]);

			const subRes = await sendCommand({ type: "subscribe_tasks", enabled: true });
			expect(subRes).toMatchObject({
				success: true,
				command: "subscribe_tasks",
				data: { subscribed: true },
			});
			await sendCommand({ type: "subscribe_tasks", enabled: true });

			rpcIo.outputLines = [];
			let ctrlSub!: TaskControl<undefined>;
			const settled = deferred<void>();
			await session.tasks.execute({
				kind: "custom",
				title: "Subscribed task",
				toolCallId: "sub-1",
				background: true,
				run: (next) => {
					ctrlSub = next;
					next.accept();
					return new Promise<TaskCompletion<undefined>>((resolve) => {
						next.signal.addEventListener(
							"abort",
							() => {
								resolve({ result: { content: [{ type: "text", text: "stopped" }], details: undefined } });
								settled.resolve();
							},
							{ once: true },
						);
					});
				},
			});
			ctrlSub.publish({ result: { content: [{ type: "text", text: "progress tick" }], details: undefined } });
			await sendCommand({ type: "kill_task", taskId: ctrlSub.id });
			await settled.promise;
			await vi.waitFor(() => {
				expect(getLifecycleEvents().map((e) => e.action)).toEqual([
					"started",
					"backgrounded",
					"stopping",
					"settled",
				]);
			});

			const events = getLifecycleEvents();
			expect(events.map((e) => e.task.id)).toEqual([ctrlSub.id, ctrlSub.id, ctrlSub.id, ctrlSub.id]);
			expect(events[0]!.task.status).toBe("running");
			expect(events[1]!.task.mode).toBe("background");
			expect(events[2]!.task.status).toBe("stopping");
			expect(events[3]!.task.status).toBe("cancelled");

			const unsubRes = await sendCommand({ type: "subscribe_tasks", enabled: false });
			expect(unsubRes).toMatchObject({
				success: true,
				command: "subscribe_tasks",
				data: { subscribed: false },
			});

			rpcIo.outputLines = [];
			let ctrlAfter!: TaskControl<undefined>;
			const gateAfter = deferred<TaskCompletion<undefined>>();
			await session.tasks.execute({
				kind: "custom",
				title: "After unsubscribe",
				toolCallId: "after-unsub",
				background: true,
				run: (next) => {
					ctrlAfter = next;
					next.accept();
					return gateAfter.promise;
				},
			});
			gateAfter.resolve({ result: { content: [{ type: "text", text: "done" }], details: undefined } });
			await vi.waitFor(() => expect(session.tasks.get(ctrlAfter.id).status).toBe("completed"));
			expect(getLifecycleEvents()).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	it("preserves task lifecycle subscription across session replacement (new_session)", async () => {
		const { runtimeHost, sendCommand, cleanup } = await startRpcMode();

		try {
			await sendCommand({ type: "subscribe_tasks", enabled: true });
			const newSessionRes = await sendCommand({ type: "new_session" });
			expect(newSessionRes).toMatchObject({
				success: true,
				command: "new_session",
				data: { cancelled: false },
			});

			rpcIo.outputLines = [];
			const gate = deferred<TaskCompletion<undefined>>();
			let ctrl!: TaskControl<undefined>;
			await runtimeHost.session.tasks.execute({
				kind: "custom",
				title: "Task on new session",
				toolCallId: "new-session-task",
				background: true,
				run: (next) => {
					ctrl = next;
					next.accept();
					return gate.promise;
				},
			});
			gate.resolve({ result: { content: [{ type: "text", text: "done" }], details: undefined } });

			await vi.waitFor(() => {
				expect(getLifecycleEvents().map((e) => e.action)).toEqual(["started", "backgrounded", "settled"]);
			});
			expect(getLifecycleEvents().every((e) => e.task.id === ctrl.id)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("cleans up task lifecycle subscription on shutdown", async () => {
		const { session, runtimeHost, sendCommand, cleanup } = await startRpcMode();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

		try {
			await sendCommand({ type: "subscribe_tasks", enabled: true });
			process.stdin.emit("end");
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));

			rpcIo.outputLines = [];
			const gate = deferred<TaskCompletion<undefined>>();
			await session.tasks.execute({
				kind: "custom",
				title: "After shutdown",
				toolCallId: "after-shutdown",
				background: true,
				run: (next) => {
					next.accept();
					return gate.promise;
				},
			});
			gate.resolve({ result: { content: [{ type: "text", text: "done" }], details: undefined } });
			await Promise.resolve();
			expect(getLifecycleEvents()).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});

describe("RpcClient tasks", () => {
	const tempDirs: string[] = [];
	const clients: RpcClient[] = [];

	function createTaskMockClient(): {
		client: RpcClient;
		snapshot: TaskSnapshot;
		readResult: TaskRead;
	} {
		const snapshot: TaskSnapshot = {
			id: "custom-abc123def456",
			kind: "custom",
			label: "custom",
			title: "Mock RPC task",
			output: "log",
			toolCallId: "call-1",
			anchorId: null,
			mode: "background",
			status: "running",
			startedAt: 1000,
		};
		const readResult: TaskRead = {
			task: snapshot,
			text: "2- before\n3: match line",
			totalBytes: 24,
			truncated: false,
			fromByte: 0,
			endByte: 24,
			filtered: true,
			totalMatches: 1,
		};

		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-tasks-"));
		tempDirs.push(dir);
		const path = join(dir, "child.mjs");
		writeFileSync(
			path,
			`
import { createInterface } from "node:readline";
const snapshot = ${JSON.stringify(snapshot)};
const readResult = ${JSON.stringify(readResult)};
let subscribed = false;
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	let data;
	switch (command.type) {
		case "list_tasks":
			data = { tasks: [snapshot] };
			break;
		case "get_task":
			if (command.taskId === "unknown") {
				process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown task ID" }) + "\\n");
				return;
			}
			data = { task: snapshot };
			break;
		case "read_task":
			data = {
				...readResult,
				text: JSON.stringify({
					mode: command.mode,
					bytes: command.bytes,
					sinceBytes: command.sinceBytes,
					endByte: command.endByte,
					filter: command.filter,
					contextLines: command.contextLines,
				}),
			};
			break;
		case "kill_task":
			data = { requested: true, task: { ...snapshot, status: "stopping" } };
			break;
		case "detach_tasks":
			data = { detached: command.taskId ? 1 : 2 };
			break;
		case "subscribe_tasks":
			subscribed = Boolean(command.enabled);
			data = { subscribed };
			break;
		default:
			data = undefined;
	}
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\\n");
	if (command.type === "subscribe_tasks" && subscribed) {
		setTimeout(() => {
			process.stdout.write(JSON.stringify({ type: "task_lifecycle", action: "started", task: snapshot }) + "\\n");
		}, 15);
	}
});
`,
		);
		const client = new RpcClient({ cliPath: path });
		clients.push(client);
		return { client, snapshot, readResult };
	}

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => {})));
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("sends typed task commands and receives RpcTaskLifecycleEvent via onEvent", async () => {
		const { client, snapshot } = createTaskMockClient();
		await client.start();

		expect(await client.listTasks()).toEqual([snapshot]);
		expect(await client.getTask(snapshot.id)).toEqual(snapshot);
		await expect(client.getTask("unknown")).rejects.toThrow("Unknown task ID");

		const read = await client.readTask(snapshot.id, {
			mode: "head",
			bytes: 512,
			sinceBytes: 10,
			endByte: 100,
			filter: "match",
			contextLines: 2,
		});
		expect(JSON.parse(read.text)).toEqual({
			mode: "head",
			bytes: 512,
			sinceBytes: 10,
			endByte: 100,
			filter: "match",
			contextLines: 2,
		});

		expect(await client.killTask(snapshot.id)).toEqual({
			requested: true,
			task: { ...snapshot, status: "stopping" },
		});
		expect(await client.detachTasks(snapshot.id)).toEqual({ detached: 1 });
		expect(await client.detachTasks()).toEqual({ detached: 2 });

		const events: RpcEvent[] = [];
		const unsubscribe = client.onEvent((event) => events.push(event));
		try {
			expect(await client.subscribeTasks(true)).toEqual({ subscribed: true });
			await vi.waitFor(() => {
				expect(events).toContainEqual({
					type: "task_lifecycle",
					action: "started",
					task: snapshot,
				});
			});
			expect(await client.subscribeTasks(false)).toEqual({ subscribed: false });
		} finally {
			unsubscribe();
		}
	});
});
