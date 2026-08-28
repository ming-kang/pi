import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
} from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBackgroundExtension, prependCommandPrefix } from "../src/extensions/background/index.ts";
import { buildNotificationContent, toNotificationDetails } from "../src/extensions/background/notify.ts";
import type { BgNotification, BgTask } from "../src/extensions/background/registry.ts";
import {
	type BgRenderState,
	renderBackgroundNotification,
	renderBgCall,
	renderBgResult,
} from "../src/extensions/background/render.ts";
import { formatStatusline } from "../src/extensions/background/task-view.ts";
import type { BgNotificationDetails, BgWaitDetails } from "../src/extensions/background/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

interface FakeExecCall {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv | undefined;
	signal: AbortSignal | undefined;
	emitData: (text: string) => void;
	finish: (exitCode: number | null) => void;
	fail: (error: Error) => void;
}

function createFakeOperations(): { operations: BashOperations; calls: FakeExecCall[] } {
	const calls: FakeExecCall[] = [];
	const operations: BashOperations = {
		exec: (command, cwd, options) =>
			new Promise((resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				calls.push({
					command,
					cwd,
					env: options.env,
					signal: options.signal,
					emitData: (text) => options.onData(Buffer.from(text)),
					finish: (exitCode) => resolve({ exitCode }),
					fail: (error) => reject(error),
				});
			}),
	};
	return { operations, calls };
}

interface FakeSentMessage {
	message: { customType: string; content: string; display: boolean; details: unknown };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

interface Harness {
	tools: Map<string, ToolDefinition<any, any, any>>;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	sent: FakeSentMessage[];
	calls: FakeExecCall[];
	ctx: ExtensionContext;
	statusUpdates: (string | undefined)[];
	notifications: string[];
	customCalls: { factory: unknown; options: unknown }[];
	startSession: () => Promise<void>;
	shutdownSession: () => Promise<void>;
	execute: (tool: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
}

const tempDirs: string[] = [];

function createHarness(stall?: { pollIntervalMs: number; thresholdMs: number }): Harness {
	const outputDir = mkdtempSync(join(tmpdir(), "pi-bg-ext-"));
	tempDirs.push(outputDir);
	const { operations, calls } = createFakeOperations();

	const tools = new Map<string, ToolDefinition<any, any, any>>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: FakeSentMessage[] = [];
	const statusUpdates: (string | undefined)[] = [];
	const notifications: string[] = [];
	const customCalls: { factory: unknown; options: unknown }[] = [];

	const pi = {
		registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, { handler: options.handler }),
		registerMessageRenderer: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) =>
			handlers.set(event, handler),
		sendMessage: (message: FakeSentMessage["message"], options: FakeSentMessage["options"]) => {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: outputDir,
		isProjectTrusted: () => true,
		// resolveSpawnContext reads these for the PI_* environment injection.
		sessionManager: { getSessionId: () => "sess-test", getSessionFile: () => undefined },
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: undefined,
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				statusUpdates.push(text);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			custom: (factory: unknown, options?: unknown) => {
				customCalls.push({ factory, options });
				return Promise.resolve(undefined);
			},
		},
	} as unknown as ExtensionContext;

	createBackgroundExtension({ operations, outputDir, ...(stall ? { stall } : {}) })(pi);

	return {
		tools,
		handlers,
		commands,
		sent,
		calls,
		ctx,
		statusUpdates,
		notifications,
		customCalls,
		startSession: async () => {
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		},
		shutdownSession: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
		},
		execute: async (tool, params, signal) => {
			const definition = tools.get(tool);
			if (!definition) throw new Error(`tool not registered: ${tool}`);
			return definition.execute("call-1", params, signal, undefined, ctx);
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("background extension", () => {
	it("registers the single bg tool and the /bg command", () => {
		const harness = createHarness();
		expect([...harness.tools.keys()]).toEqual(["bg"]);
		expect(harness.commands.has("bg")).toBe(true);
		const tool = harness.tools.get("bg");
		expect(tool?.description).toContain("create:");
		expect(tool?.description).toContain("wait:");
		expect(tool?.description).toContain("Do NOT append '&'");
		expect(tool?.promptGuidelines?.[1]).toContain("Never wait");
		expect((tool?.parameters as { type?: string }).type).toBe("object");
	});

	it("starts a task immediately and ignores the turn abort signal", async () => {
		const harness = createHarness();
		await harness.startSession();

		const turnAbort = new AbortController();
		const result = await harness.execute("bg", { action: "create", command: "npm run build" }, turnAbort.signal);
		const text = textOf(result);
		expect(text).toMatch(/Started background task bg-[0-9a-f]{6}/);
		expect(text).toContain("Output file:");
		expect(text).toContain("do NOT poll");

		// Aborting the turn must not abort the background task.
		turnAbort.abort();
		expect(harness.calls[0]?.signal?.aborted).toBe(false);

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("notifies with an escaped XML payload and embedded tail on completion", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: 'echo "a<b" && true' });
		harness.calls[0]?.emitData("value is a<b\ndone\n");
		harness.calls[0]?.finish(0);

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const sent = harness.sent[0];
		expect(sent?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(sent?.message.customType).toBe("background-task");
		expect(sent?.message.display).toBe(true);

		const content = sent?.message.content ?? "";
		expect(content).toContain('status="completed"');
		expect(content).toContain('exitCode="0"');
		expect(content).toContain("<command>echo &quot;a&lt;b&quot; &amp;&amp; true</command>");
		expect(content).toContain("value is a&lt;b\ndone");
		expect(content).toContain("<output-file>");

		const details = sent?.message.details as { taskId: string; status: string; tailText: string };
		expect(details.status).toBe("completed");
		expect(details.tailText).toBe("value is a<b\ndone\n");
	});

	it("strips XML-illegal characters from command and error fields", async () => {
		const harness = createHarness();
		await harness.startSession();

		// Lone surrogate (U+D800), non-characters (U+FFFE/U+FFFF), C0 control (U+0001).
		await harness.execute("bg", { action: "create", command: "x\uD800y\uFFFEz\uFFFFw\u0001v" });
		harness.calls[0]?.fail(new Error("boom\u0007"));

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const content = harness.sent[0]?.message.content ?? "";
		expect(content).toContain("<command>xyzwv</command>");
		expect(content).toContain("<error>boom</error>");
		expect(content).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
		expect(content).not.toMatch(/[\ud800-\udfff\ufffe\uffff]/);
	});

	it("keeps XML-legal whitespace in command fields and filters the output tail too", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "echo\tline" });
		harness.calls[0]?.emitData("out\uFFFEput\n");
		harness.calls[0]?.finish(0);

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const content = harness.sent[0]?.message.content ?? "";
		expect(content).toContain("<command>echo\tline</command>");
		expect(content).not.toMatch(/[\ud800-\udfff\ufffe\uffff]/);
		// The tail is part of the same XML document and goes through the same filter.
		expect(content).toContain("output");
		expect(content).not.toContain("\uFFFE");
	});

	it("tracks the footer status through the task lifecycle and shutdown", async () => {
		const harness = createHarness();
		await harness.startSession();
		expect(harness.statusUpdates.at(-1)).toBeUndefined();

		await harness.execute("bg", { action: "create", command: "sleep 5" });
		expect(harness.statusUpdates.at(-1)).toBe("bg 1 running");

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.statusUpdates.at(-1)).toBe("bg 1 done"));

		await harness.shutdownSession();
		expect(harness.statusUpdates.at(-1)).toBeUndefined();
	});

	it("reads logs by prefix with clamped bounds and mode selection", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg", { action: "create", command: "npm test" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";
		harness.calls[0]?.emitData(`${"x".repeat(600)}\nhello tail\n`);

		// The write stream flushes asynchronously; poll until the tail is visible.
		await vi.waitFor(async () => {
			const tail = await harness.execute("bg", { action: "read", taskId: taskId.slice(0, 6), bytes: 300 });
			const tailText = textOf(tail);
			expect(tailText).toContain("hello tail");
			expect(tailText).toContain(`task ${taskId} running`);
			expect(tailText).toContain("still running");
			expect(tailText).toContain("full output:");
		});

		const head = await harness.execute("bg", { action: "read", taskId, mode: "head", bytes: 300 });
		expect(textOf(head)).toContain("x".repeat(100));
		expect(textOf(head)).not.toContain("hello tail");

		await expect(harness.execute("bg", { action: "read", taskId: "bg-zzz" })).rejects.toThrow(/No background task/);

		await harness.execute("bg", { action: "create", command: "second" });
		await expect(harness.execute("bg", { action: "read", taskId: "bg-" })).rejects.toThrow(/ambiguous/i);

		harness.calls[0]?.finish(0);
		harness.calls[1]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(2));
	});

	it("rejects actions that miss their required fields", async () => {
		const harness = createHarness();
		await harness.startSession();

		await expect(harness.execute("bg", { action: "create" })).rejects.toThrow(/requires 'command'/);
		await expect(harness.execute("bg", { action: "read" })).rejects.toThrow(/requires 'taskId'/);
		await expect(harness.execute("bg", { action: "wait" })).rejects.toThrow(/requires 'taskId'/);
		await expect(harness.execute("bg", { action: "kill" })).rejects.toThrow(/requires 'taskId'/);
		expect(harness.calls).toHaveLength(0);
	});

	it("wait delivers a completion inline and suppresses the followUp notification", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg", { action: "create", command: "npm run build", description: "build" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";
		harness.calls[0]?.emitData("building\n");

		// waitForResult registers its waiter synchronously up to the first await,
		// so finishing right after the call starts is a deterministic claim.
		const waitPromise = harness.execute("bg", { action: "wait", taskId, waitMs: 5_000, sinceBytes: 0 });
		harness.calls[0]?.finish(0);
		const result = await waitPromise;

		const text = textOf(result);
		expect(text).toContain("completed");
		expect(text).toContain("building");
		expect(text).toContain("+9B new output");
		// The claim protocol suppresses the followUp: this result is the single delivery.
		expect(harness.sent).toHaveLength(0);

		const details = result.details as BgWaitDetails;
		expect(details.action).toBe("wait");
		expect(details.timedOut).toBe(false);
		expect(details.deltaBytes).toBe(9);
		expect(details.status).toBe("completed");
	});

	it("wait times out while the task keeps running; the followUp still fires later", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg", { action: "create", command: "npm run dev" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";
		harness.calls[0]?.emitData("progress line\n");

		const result = await harness.execute("bg", { action: "wait", taskId, waitMs: 1_100 });
		const text = textOf(result);
		expect(text).toContain("still running");
		expect(text).toContain("Do not sleep-poll");
		expect(text).toContain("progress line");
		expect((result.details as BgWaitDetails).timedOut).toBe(true);
		expect(harness.sent).toHaveLength(0);

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("an aborted wait hands the claim back so the followUp still fires", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg", { action: "create", command: "npm run build" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";
		harness.calls[0]?.emitData("building\n");

		const controller = new AbortController();
		const waitPromise = harness.execute("bg", { action: "wait", taskId, waitMs: 5_000 }, controller.signal);
		// The turn is interrupted, so this result is discarded. The wait must not
		// keep the delivery claim it registered, or the completion is lost.
		controller.abort();
		await expect(waitPromise).rejects.toThrow("aborted");

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		expect(harness.sent[0]?.message.content).toContain('status="completed"');
	});

	it("lists tasks with running first and the description in the label", async () => {
		const harness = createHarness();
		await harness.startSession();

		const empty = await harness.execute("bg", { action: "list" });
		expect(textOf(empty)).toContain("No background tasks");

		await harness.execute("bg", { action: "create", command: "npm run dev", description: "dev server" });
		const listing = textOf(await harness.execute("bg", { action: "list" }));
		expect(listing).toContain("1 running · 0 finished");
		expect(listing).toContain("dev server — npm run dev");

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("caps the finished entries in list output", async () => {
		const harness = createHarness();
		await harness.startSession();

		for (let i = 0; i < 7; i++) {
			await harness.execute("bg", { action: "create", command: `cmd-${i}` });
			harness.calls[i]?.finish(0);
		}
		await vi.waitFor(() => expect(harness.sent).toHaveLength(7));

		const text = textOf(await harness.execute("bg", { action: "list" }));
		expect(text).toContain("0 running · 7 finished");
		expect(text).toContain("(+2 more finished");
	});

	it("carries the description into the completion notification", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "npm run dev", description: "dev <server>" });
		harness.calls[0]?.finish(0);

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const content = harness.sent[0]?.message.content ?? "";
		expect(content).toContain("<description>dev &lt;server&gt;</description>");
	});

	it("sends a one-shot stalled-task notification with advice when output blocks on a prompt", async () => {
		const harness = createHarness({ pollIntervalMs: 5, thresholdMs: 15 });
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "npm install" });
		harness.calls[0]?.emitData("Proceed? (y/n) ");

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const sent = harness.sent[0];
		expect(sent?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		const content = sent?.message.content ?? "";
		expect(content).toContain('status="running"');
		expect(content).toContain('waiting-for-input="true"');
		expect(content).toContain("(y/n)");
		expect(content).toContain("<advice>");
		expect(content).toContain("bg action kill");
		const details = sent?.message.details as { stalled?: boolean; status: string };
		expect(details.stalled).toBe(true);
		expect(details.status).toBe("running");

		// Statusline reflects the waiting-for-input state and clears on completion.
		await vi.waitFor(() => expect(harness.statusUpdates.at(-1)).toBe("bg 1 waiting for input"));
		harness.calls[0]?.finish(0);
		await vi.waitFor(() => {
			expect(harness.sent).toHaveLength(2);
			expect(harness.statusUpdates.at(-1)).toBe("bg 1 done");
		});
	});

	it("kills a running task and rejects a second kill", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg", { action: "create", command: "npm run dev" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";

		const killed = await harness.execute("bg", { action: "kill", taskId });
		expect(textOf(killed)).toContain(`Killed task ${taskId}`);
		expect(harness.calls[0]?.signal?.aborted).toBe(true);

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		expect(harness.sent[0]?.message.content).toContain('status="killed"');

		await expect(harness.execute("bg", { action: "kill", taskId })).rejects.toThrow(/not running/);
	});

	it("refuses new tasks after shutdown and stays silent for killed ones", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "sleep 100" });
		await harness.shutdownSession();

		expect(harness.calls[0]?.signal?.aborted).toBe(true);
		expect(harness.sent).toHaveLength(0);
		await expect(harness.execute("bg", { action: "create", command: "echo" })).rejects.toThrow(
			/not available|shutting down/,
		);
	});

	it("reports spawn failures through the notification channel", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "boom" });
		harness.calls[0]?.fail(new Error("Working directory does not exist: /missing"));

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const content = harness.sent[0]?.message.content ?? "";
		expect(content).toContain('status="failed"');
		expect(content).toContain("Working directory does not exist");
	});

	it("injects PI_* session variables like the built-in bash tool", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "env" });
		expect(harness.calls[0]?.env).toMatchObject({
			PI_SESSION_ID: "sess-test",
			PI_PROVIDER: "test-provider",
			PI_MODEL: "test-model",
		});

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("rejects a non-positive timeout synchronously without starting a task", async () => {
		const harness = createHarness();
		await harness.startSession();

		// Same rule and same wording as the built-in bash tool.
		await expect(harness.execute("bg", { action: "create", command: "x", timeout: 0 })).rejects.toThrow(
			/Invalid timeout/,
		);
		await expect(harness.execute("bg", { action: "create", command: "x", timeout: -5 })).rejects.toThrow(
			/Invalid timeout/,
		);
		expect(harness.calls).toHaveLength(0);
		expect(harness.statusUpdates.at(-1)).toBeUndefined();
	});

	it("rejects an over-limit timeout synchronously without starting a task", async () => {
		const harness = createHarness();
		await harness.startSession();

		await expect(harness.execute("bg", { action: "create", command: "x", timeout: 3_000_000_000 })).rejects.toThrow(
			/maximum/,
		);
		expect(harness.calls).toHaveLength(0);
		expect(harness.statusUpdates.at(-1)).toBeUndefined();
	});

	it("opens /bg as an inline component without overlay options", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg", { action: "create", command: "npm run dev" });
		const bg = harness.commands.get("bg");
		await bg?.handler("", harness.ctx as unknown as ExtensionCommandContext);

		expect(harness.customCalls).toHaveLength(1);
		expect(harness.customCalls[0]?.options).toBeUndefined();

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("summarizes tasks via /bg outside the TUI", async () => {
		const harness = createHarness();
		await harness.startSession();

		const bg = harness.commands.get("bg");
		const rpcCtx = { ...harness.ctx, mode: "rpc" } as unknown as ExtensionCommandContext;

		await bg?.handler("", rpcCtx);
		expect(harness.notifications.at(-1)).toBe("No background tasks.");

		await harness.execute("bg", { action: "create", command: "npm run dev" });
		await bg?.handler("", rpcCtx);
		expect(harness.notifications.at(-1)).toContain("running");
		expect(harness.notifications.at(-1)).toContain("action kill");

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});
});

describe("renderBackgroundNotification", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const details: BgNotificationDetails = {
		taskId: "bg-abc123",
		command: "npm run build",
		status: "completed",
		exitCode: 0,
		runtimeMs: 12_000,
		outputPath: "/tmp/pi-bg-abc123.log",
		totalBytes: 200,
		tailText: "build finished\n",
		tailTruncated: false,
	};

	function message(overrides?: Partial<BgNotificationDetails>): CustomMessage<BgNotificationDetails> {
		return {
			role: "custom",
			customType: "background-task",
			content: "",
			display: true,
			details: { ...details, ...overrides },
			timestamp: Date.now(),
		};
	}

	it("renders a collapsed summary and expands with the output tail", () => {
		const collapsed = renderBackgroundNotification(message(), { expanded: false, outputPad: 1 }, plainTheme);
		expect(collapsed).toBeDefined();
		const collapsedLines = (collapsed?.render(120) ?? []).map(stripTerminalSequences);
		expect(collapsedLines.join("\n")).toContain("bg-abc123");
		expect(collapsedLines.join("\n")).toContain("completed, exit 0");
		expect(collapsedLines.join("\n")).not.toContain("build finished");
		// Collapsed keeps the row compact: file name only, not the full path.
		expect(collapsedLines.join("\n")).toContain("pi-bg-abc123.log");
		expect(collapsedLines.join("\n")).not.toContain("/tmp/pi-bg-abc123.log");

		const expanded = renderBackgroundNotification(message(), { expanded: true, outputPad: 1 }, plainTheme);
		const expandedLines = (expanded?.render(120) ?? []).map(stripTerminalSequences);
		expect(expandedLines.join("\n")).toContain("build finished");
		expect(expandedLines.join("\n")).toContain("/tmp/pi-bg-abc123.log");
	});

	it("keeps the end of an oversized tail when expanded", () => {
		const tailText = `HEAD${"x".repeat(4500)}TAIL`;
		const expanded = renderBackgroundNotification(
			message({ tailText }),
			{ expanded: true, outputPad: 1 },
			plainTheme,
		);
		const text = (expanded?.render(200) ?? []).map(stripTerminalSequences).join("\n");
		expect(text).toContain("TAIL");
		expect(text).not.toContain("HEAD");
	});

	it("falls back to the default renderer for malformed details", () => {
		expect(
			renderBackgroundNotification(
				message({ taskId: undefined as unknown as string }),
				{ expanded: false, outputPad: 1 },
				plainTheme,
			),
		).toBeUndefined();
	});

	it("renders a stalled notification as waiting-for-input with advice on expand", () => {
		const stalled = message({ stalled: true, status: "running", tailText: "Proceed? (y/n)\n" });

		const collapsed = renderBackgroundNotification(stalled, { expanded: false, outputPad: 1 }, plainTheme);
		const collapsedText = (collapsed?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("waiting for input");
		expect(collapsedText).not.toContain("(y/n)");

		const expanded = renderBackgroundNotification(stalled, { expanded: true, outputPad: 1 }, plainTheme);
		const expandedText = (expanded?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(expandedText).toContain("Proceed? (y/n)");
		expect(expandedText).toContain("kill");
	});
});

describe("prependCommandPrefix", () => {
	it("prepends the configured prefix to every executed command, passing options through", async () => {
		const seen: { command: string; cwd: string; timeout?: number }[] = [];
		const base: BashOperations = {
			exec: async (command, cwd, options) => {
				seen.push({ command, cwd, timeout: options.timeout });
				return { exitCode: 0 };
			},
		};
		const wrapped = prependCommandPrefix(base, "shopt -s expand_aliases");

		const result = await wrapped.exec("npm run build", "/work", {
			onData: () => {},
			signal: undefined,
			timeout: 5,
			env: { FOO: "bar" },
		});

		expect(result).toEqual({ exitCode: 0 });
		expect(seen).toEqual([{ command: "shopt -s expand_aliases\nnpm run build", cwd: "/work", timeout: 5 }]);
	});

	it("returns the same operations without a prefix", () => {
		const base: BashOperations = { exec: async () => ({ exitCode: 0 }) };
		expect(prependCommandPrefix(base, undefined)).toBe(base);
		expect(prependCommandPrefix(base, "")).toBe(base);
	});
});

describe("renderBgCall", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("stays renderable while streaming incomplete arguments", () => {
		const empty = renderBgCall({} as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(empty.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg");

		const partialAction = renderBgCall({ action: "cre" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(partialAction.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg cre");

		const createWithoutCommand = renderBgCall({ action: "create" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(createWithoutCommand.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg create");
	});

	it("shows the full multi-line create command only when expanded", () => {
		const args = { action: "create" as const, command: "echo one\necho two\necho three" };

		const collapsed = renderBgCall(args, plainTheme, { expanded: false } as ToolRenderContext);
		const collapsedText = collapsed.render(200).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("+2 lines");
		expect(collapsedText).not.toContain("echo three");

		const expanded = renderBgCall(args, plainTheme, { expanded: true } as ToolRenderContext);
		const expandedText = expanded.render(200).map(stripTerminalSequences).join("\n");
		expect(expandedText).toContain("echo two");
		expect(expandedText).toContain("echo three");
		expect(expandedText).not.toContain("+2 lines");
	});

	it("renders one line per action with the task id and parameters", () => {
		const cases: [
			{
				action: "read" | "wait" | "kill" | "list";
				taskId?: string;
				mode?: "head" | "tail";
				bytes?: number;
				waitMs?: number;
			},
			RegExp,
		][] = [
			[{ action: "read", taskId: "bg-3f", mode: "tail", bytes: 8192 }, /^bg read bg-3f tail/],
			[{ action: "wait", taskId: "3f", waitMs: 20_000 }, /^bg wait 3f 20s/],
			[{ action: "kill", taskId: "bg-3f" }, /^bg kill bg-3f/],
			[{ action: "list" }, /^bg list/],
		];
		for (const [args, pattern] of cases) {
			const component = renderBgCall(args as never, plainTheme, { expanded: false } as ToolRenderContext);
			const text = component.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(pattern);
		}
	});

	it("appends the description label to a create call", () => {
		const component = renderBgCall(
			{ action: "create", command: "npm run dev", description: "dev server" },
			plainTheme,
			{ expanded: false } as ToolRenderContext,
		);
		const text = component.render(200).map(stripTerminalSequences).join("\n");
		expect(text).toContain("npm run dev & · dev server");
	});
});

describe("renderBgCall wait live line", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("shows elapsed/window and the output delta while pending, then settles", () => {
		vi.useFakeTimers();
		try {
			const state: BgRenderState = {};
			let bytes = 100;
			const probe = () => ({ status: "running" as const, outputBytes: bytes });
			const context = {
				expanded: false,
				executionStarted: true,
				isPartial: true,
				state,
				invalidate: vi.fn(),
			} as unknown as ToolRenderContext<BgRenderState>;

			const first = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, probe);
			expect(first.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f waiting 0s\/20s/);
			expect(state.refreshTimer).toBeDefined();

			// Output grows; the armed timer invalidates and the next render shows the delta.
			bytes = 3378;
			vi.advanceTimersByTime(1000);
			expect(context.invalidate).toHaveBeenCalledTimes(1);
			const second = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, probe);
			const text = second.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(/^bg wait bg-3f waiting 1s\/20s/);
			expect(text).toContain("+3.2KB new output");

			// Settled: timer cleared, static form returns.
			const settledContext = {
				expanded: false,
				executionStarted: true,
				isPartial: false,
				state,
			} as unknown as ToolRenderContext<BgRenderState>;
			const settled = renderBgCall(
				{ action: "wait", taskId: "bg-3f", waitMs: 20_000 },
				plainTheme,
				settledContext,
				probe,
			);
			expect(settled.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f 20s/);
			expect(state.refreshTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays static until execution starts", () => {
		const state: BgRenderState = {};
		// Arguments are still streaming, or this is a replayed transcript row that
		// will never settle. Either way there is nothing to count up to yet.
		const context = {
			expanded: false,
			executionStarted: false,
			isPartial: true,
			state,
		} as unknown as ToolRenderContext<BgRenderState>;

		const line = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, () => ({
			status: "running" as const,
			outputBytes: 100,
		}));
		expect(line.render(200).map(stripTerminalSequences).join("\n")).not.toContain("waiting");
		expect(state.refreshTimer).toBeUndefined();
	});

	it("falls back to the static line without shell state", () => {
		const component = renderBgCall(
			{ action: "wait", taskId: "bg-3f", waitMs: 5000 },
			plainTheme,
			{ expanded: false, isPartial: true } as ToolRenderContext<BgRenderState>,
			() => ({ status: "running", outputBytes: 10 }),
		);
		expect(component.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f 5s/);
	});
});

describe("renderBgResult summaries", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("carries the description label on a create summary", () => {
		const component = renderBgResult(
			{
				content: [{ type: "text", text: "Started background task bg-3f." }],
				details: {
					action: "create",
					taskId: "bg-3f",
					outputPath: "/tmp/pi-bg-3f.log",
					command: "npm run dev",
					description: "dev server",
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			{ args: { action: "create" }, state: {} } as ToolRenderContext,
		);
		const text = component.render(200).map(stripTerminalSequences).join("\n");
		expect(text).toContain("bg-3f (dev server) started");
	});
});

describe("formatStatusline", () => {
	it("reports running and done counts", () => {
		expect(formatStatusline({ running: 2, total: 3, stalled: 0 })).toBe("bg 2 running · 1 done");
	});

	it("splits stalled tasks out of the running count so the counts add up", () => {
		expect(formatStatusline({ running: 3, total: 4, stalled: 1 })).toBe(
			"bg 2 running · 1 waiting for input · 1 done",
		);
	});

	it("reports a lone stalled task without a running segment", () => {
		expect(formatStatusline({ running: 1, total: 1, stalled: 1 })).toBe("bg 1 waiting for input");
	});

	it("hides the segment when no tasks exist", () => {
		expect(formatStatusline({ running: 0, total: 0, stalled: 0 })).toBeUndefined();
	});
});

describe("buildNotificationContent", () => {
	const task: BgTask = {
		id: "bg-abc123",
		command: "npm run build",
		cwd: "/w",
		status: "completed",
		startedAt: 1_000,
		endedAt: 13_000,
		stalled: false,
		exitCode: 0,
		outputPath: "/tmp/pi-bg-abc123.log",
		outputBytes: 200,
		outputTruncated: false,
		notified: false,
	};

	const tail = { text: "done\n", sliceBytes: 5, totalBytes: 200, truncated: true, startsMidLine: true };

	function notification(overrides?: Partial<BgNotification>): BgNotification {
		return { kind: "completion", task, tail, ...overrides };
	}

	it("renders a completion with its exit code, runtime, and tail metadata", () => {
		const xml = buildNotificationContent(notification());
		expect(xml).toContain('<background-task id="bg-abc123" status="completed" exitCode="0" runtime="12s">');
		expect(xml).toContain("<command>npm run build</command>");
		expect(xml).toContain("<output-file>/tmp/pi-bg-abc123.log</output-file>");
		expect(xml).toContain('<output-tail bytes="5" totalBytes="200" truncated="true" startsMidLine="true">');
		expect(xml).not.toContain("waiting-for-input");
		expect(xml).not.toContain("<advice>");
	});

	it("omits exitCode when the task produced none and includes the error and description", () => {
		const failed = {
			...task,
			status: "failed" as const,
			exitCode: null,
			error: "Command was terminated by a signal.",
		};
		const xml = buildNotificationContent(notification({ task: { ...failed, description: "build" } }));
		expect(xml).toContain('status="failed"');
		expect(xml).not.toContain("exitCode=");
		expect(xml).toContain("<description>build</description>");
		expect(xml).toContain("<error>Command was terminated by a signal.</error>");
	});

	it("renders a stall as a still-running task with advice and no exit code or error", () => {
		const stalled = {
			...task,
			status: "running" as const,
			endedAt: undefined,
			exitCode: undefined,
			error: "ignored",
		};
		const xml = buildNotificationContent(notification({ kind: "stall", task: stalled }));
		expect(xml).toContain('status="running" waiting-for-input="true"');
		expect(xml).not.toContain("exitCode=");
		expect(xml).not.toContain("<error>");
		expect(xml).toContain("<advice>");
		expect(xml).toContain("non-interactive flag");
	});

	it("escapes markup and strips XML-illegal characters from every text field", () => {
		const hostile = { ...task, command: 'echo "a<b" && c>d \u0000\uFFFE', description: "it's <b>" };
		const xml = buildNotificationContent(notification({ task: hostile }));
		expect(xml).toContain("<command>echo &quot;a&lt;b&quot; &amp;&amp; c&gt;d </command>");
		expect(xml).toContain("<description>it&apos;s &lt;b&gt;</description>");
		expect(xml).not.toContain("\u0000");
		expect(xml).not.toContain("\uFFFE");
	});

	it("reports an unreadable tail instead of an empty one", () => {
		const xml = buildNotificationContent(notification({ tail: undefined, tailError: "ENOENT: no such file" }));
		expect(xml).toContain('<output-tail unavailable="ENOENT: no such file"/>');
	});

	it("falls back to (no output) for an empty tail", () => {
		const xml = buildNotificationContent(notification({ tail: { ...tail, text: "", truncated: false } }));
		expect(xml).toContain("(no output)");
	});
});

describe("toNotificationDetails", () => {
	const task: BgTask = {
		id: "bg-abc123",
		command: "npm run build",
		cwd: "/w",
		status: "failed",
		startedAt: 1_000,
		endedAt: 13_000,
		stalled: false,
		exitCode: 2,
		error: "Command exited with code 2",
		outputPath: "/tmp/pi-bg-abc123.log",
		outputBytes: 200,
		outputTruncated: false,
		notified: false,
	};
	const tail = { text: "boom\n", sliceBytes: 5, totalBytes: 200, truncated: true, startsMidLine: false };

	it("projects a completion onto the persisted shape", () => {
		const details = toNotificationDetails({ kind: "completion", task, tail });
		expect(details).toMatchObject({
			taskId: "bg-abc123",
			status: "failed",
			exitCode: 2,
			runtimeMs: 12_000,
			totalBytes: 200,
			tailText: "boom\n",
			tailTruncated: true,
			error: "Command exited with code 2",
		});
		expect(details.stalled).toBeUndefined();
	});

	it("keeps the historical `stalled` flag rather than leaking the kind discriminant", () => {
		const running = { ...task, status: "running" as const, endedAt: undefined };
		const details = toNotificationDetails({ kind: "stall", task: running, tail });
		// The persisted shape is a compatibility surface: older transcripts are
		// rendered by this build, so the flag it has always carried must stay.
		expect(details.stalled).toBe(true);
		expect(details).not.toHaveProperty("kind");
		expect(details.status).toBe("running");
		// A stall is informational: no terminal exit code, no error of its own.
		expect(details.exitCode).toBeUndefined();
		expect(details.error).toBeUndefined();
	});
});
