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
} from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { BgNotificationDetails } from "../src/extensions/background/index.ts";
import { createBackgroundExtension } from "../src/extensions/background/index.ts";
import { renderBackgroundNotification } from "../src/extensions/background/render.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function textOf(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

interface FakeExecCall {
	command: string;
	cwd: string;
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
	startSession: () => Promise<void>;
	shutdownSession: () => Promise<void>;
	execute: (tool: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
}

const tempDirs: string[] = [];

function createHarness(): Harness {
	const outputDir = mkdtempSync(join(tmpdir(), "pi-bg-ext-"));
	tempDirs.push(outputDir);
	const { operations, calls } = createFakeOperations();

	const tools = new Map<string, ToolDefinition<any, any, any>>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: FakeSentMessage[] = [];
	const statusUpdates: (string | undefined)[] = [];
	const notifications: string[] = [];

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
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				statusUpdates.push(text);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	createBackgroundExtension({ operations, outputDir })(pi);

	return {
		tools,
		handlers,
		commands,
		sent,
		calls,
		ctx,
		statusUpdates,
		notifications,
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
	it("registers the three tools and the /bg command", () => {
		const harness = createHarness();
		expect([...harness.tools.keys()].sort()).toEqual(["bg_bash", "bg_kill", "bg_logs"]);
		expect(harness.commands.has("bg")).toBe(true);
		expect(harness.tools.get("bg_bash")?.promptGuidelines?.[0]).toContain("Never poll");
		for (const tool of harness.tools.values()) {
			expect((tool.parameters as { type?: string }).type).toBe("object");
		}
	});

	it("starts a task immediately and ignores the turn abort signal", async () => {
		const harness = createHarness();
		await harness.startSession();

		const turnAbort = new AbortController();
		const result = await harness.execute("bg_bash", { command: "npm run build" }, turnAbort.signal);
		const text = textOf(result);
		expect(text).toMatch(/Started background task bg-[0-9a-f]{6}/);
		expect(text).toContain("Output file:");
		expect(text).toContain("Do NOT poll");

		// Aborting the turn must not abort the background task.
		turnAbort.abort();
		expect(harness.calls[0]?.signal?.aborted).toBe(false);

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
	});

	it("notifies with an escaped XML payload and embedded tail on completion", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg_bash", { command: 'echo "a<b" && true' });
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

	it("tracks the footer status through the task lifecycle and shutdown", async () => {
		const harness = createHarness();
		await harness.startSession();
		expect(harness.statusUpdates.at(-1)).toBeUndefined();

		await harness.execute("bg_bash", { command: "sleep 5" });
		expect(harness.statusUpdates.at(-1)).toBe("bg 1 running");

		harness.calls[0]?.finish(0);
		await vi.waitFor(() => expect(harness.statusUpdates.at(-1)).toBe("bg 1 done"));

		await harness.shutdownSession();
		expect(harness.statusUpdates.at(-1)).toBeUndefined();
	});

	it("reads logs by prefix with clamped bounds and mode selection", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg_bash", { command: "npm test" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";
		harness.calls[0]?.emitData(`${"x".repeat(600)}\nhello tail\n`);

		// The write stream flushes asynchronously; poll until the tail is visible.
		await vi.waitFor(async () => {
			const tail = await harness.execute("bg_logs", { taskId: taskId.slice(0, 6), bytes: 300 });
			const tailText = textOf(tail);
			expect(tailText).toContain("hello tail");
			expect(tailText).toContain(`task ${taskId} running`);
			expect(tailText).toContain("full output:");
		});

		const head = await harness.execute("bg_logs", { taskId, mode: "head", bytes: 300 });
		expect(textOf(head)).toContain("x".repeat(100));
		expect(textOf(head)).not.toContain("hello tail");

		await expect(harness.execute("bg_logs", { taskId: "bg-zzz" })).rejects.toThrow(/No background task/);

		await harness.execute("bg_bash", { command: "second" });
		await expect(harness.execute("bg_logs", { taskId: "bg-" })).rejects.toThrow(/ambiguous/i);

		harness.calls[0]?.finish(0);
		harness.calls[1]?.finish(0);
		await vi.waitFor(() => expect(harness.sent).toHaveLength(2));
	});

	it("kills a running task and rejects a second kill", async () => {
		const harness = createHarness();
		await harness.startSession();

		const started = await harness.execute("bg_bash", { command: "npm run dev" });
		const taskId = /bg-[0-9a-f]{6}/.exec(textOf(started))?.[0] ?? "";

		const killed = await harness.execute("bg_kill", { taskId });
		expect(textOf(killed)).toContain(`Killed task ${taskId}`);
		expect(harness.calls[0]?.signal?.aborted).toBe(true);

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		expect(harness.sent[0]?.message.content).toContain('status="killed"');

		await expect(harness.execute("bg_kill", { taskId })).rejects.toThrow(/not running/);
	});

	it("refuses new tasks after shutdown and stays silent for killed ones", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg_bash", { command: "sleep 100" });
		await harness.shutdownSession();

		expect(harness.calls[0]?.signal?.aborted).toBe(true);
		expect(harness.sent).toHaveLength(0);
		await expect(harness.execute("bg_bash", { command: "echo" })).rejects.toThrow(/not available|shutting down/);
	});

	it("reports spawn failures through the notification channel", async () => {
		const harness = createHarness();
		await harness.startSession();

		await harness.execute("bg_bash", { command: "boom" });
		harness.calls[0]?.fail(new Error("Working directory does not exist: /missing"));

		await vi.waitFor(() => expect(harness.sent).toHaveLength(1));
		const content = harness.sent[0]?.message.content ?? "";
		expect(content).toContain('status="failed"');
		expect(content).toContain("Working directory does not exist");
	});

	it("summarizes tasks via /bg outside the TUI", async () => {
		const harness = createHarness();
		await harness.startSession();

		const bg = harness.commands.get("bg");
		const rpcCtx = { ...harness.ctx, mode: "rpc" } as unknown as ExtensionCommandContext;

		await bg?.handler("", rpcCtx);
		expect(harness.notifications.at(-1)).toBe("No background tasks.");

		await harness.execute("bg_bash", { command: "npm run dev" });
		await bg?.handler("", rpcCtx);
		expect(harness.notifications.at(-1)).toContain("running");
		expect(harness.notifications.at(-1)).toContain("bg_kill");

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

		const expanded = renderBackgroundNotification(message(), { expanded: true, outputPad: 1 }, plainTheme);
		const expandedLines = (expanded?.render(120) ?? []).map(stripTerminalSequences);
		expect(expandedLines.join("\n")).toContain("build finished");
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
});
