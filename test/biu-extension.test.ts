import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import biu, {
	BIU_COMMAND_NAME,
	BIU_KICKOFF_MESSAGE_TYPE,
	BIU_MODE_ENTRY_TYPE,
	BIU_MODE_SCHEMA_VERSION,
	BIU_STATUS_KEY,
	replayBiuMode,
} from "../src/extensions/biu/index.ts";
import { getBiuPaths, loadBiuState } from "../src/extensions/biu/state.ts";
import { BIU_TOOL_NAME, type BiuToolDetails, type BiuToolParams } from "../src/extensions/biu/tool.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

type HookHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface CapturedMessage {
	message: { customType: string; content: string; display?: boolean; details?: unknown };
	options?: { triggerTurn?: boolean };
}

interface ExtensionHarness {
	commands: Map<string, RegisteredCommand>;
	hooks: Map<string, HookHandler>;
	entries: Array<{ customType: string; data: unknown }>;
	messages: CapturedMessage[];
	renderers: Map<string, unknown>;
	activeTools: string[];
	tool: ToolDefinition<any, BiuToolDetails> | undefined;
}

function captureExtension(initialActiveTools: string[] = ["read", BIU_TOOL_NAME]): ExtensionHarness {
	const harness: ExtensionHarness = {
		commands: new Map(),
		hooks: new Map(),
		entries: [],
		messages: [],
		renderers: new Map(),
		activeTools: [...initialActiveTools],
		tool: undefined,
	};
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => harness.commands.set(name, command),
		registerTool: (tool: ToolDefinition<any, BiuToolDetails>) => {
			harness.tool = tool;
		},
		registerMessageRenderer: (customType: string, renderer: unknown) => harness.renderers.set(customType, renderer),
		on: (event: string, handler: HookHandler) => harness.hooks.set(event, handler),
		appendEntry: (customType: string, data: unknown) => harness.entries.push({ customType, data }),
		sendMessage: (message: CapturedMessage["message"], options?: CapturedMessage["options"]) =>
			harness.messages.push({ message, options }),
		getActiveTools: () => [...harness.activeTools],
		setActiveTools: (names: string[]) => {
			harness.activeTools = [...names];
		},
	} as unknown as ExtensionAPI;
	biu(pi);
	return harness;
}

interface ContextHarness {
	ctx: ExtensionCommandContext;
	statuses: Map<string, string | undefined>;
	notifications: Array<{ message: string; level?: string }>;
	select: ReturnType<typeof vi.fn>;
	setBranch: (branch: unknown[]) => void;
}

function createContext(cwd: string, initialBranch: unknown[] = [], hasUI = true): ContextHarness {
	let branch = initialBranch;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const select = vi.fn(async () => undefined as string | undefined);
	const ctx = {
		cwd,
		hasUI,
		waitForIdle: vi.fn(async () => {}),
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			select,
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		statuses,
		notifications,
		select,
		setBranch: (nextBranch) => {
			branch = nextBranch;
		},
	};
}

function modeEntry(enabled: boolean): unknown {
	return {
		type: "custom",
		customType: BIU_MODE_ENTRY_TYPE,
		data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled },
	};
}

async function runCommand(harness: ExtensionHarness, ctx: ExtensionCommandContext, args = ""): Promise<void> {
	const command = harness.commands.get(BIU_COMMAND_NAME);
	if (!command) throw new Error("biu command not registered");
	await command.handler(args, ctx);
}

async function runTool(
	harness: ExtensionHarness,
	ctx: ExtensionCommandContext,
	params: Partial<BiuToolParams>,
): Promise<{ text: string; details: BiuToolDetails }> {
	const tool = harness.tool;
	if (!tool) throw new Error("biu tool not registered");
	const result = await tool.execute("call-1", params as BiuToolParams, undefined, undefined, ctx);
	const text = result.content
		.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
	return { text, details: result.details as BiuToolDetails };
}

let agentDir: string;
let cwd: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "biu-agent-"));
	cwd = await mkdtemp(join(tmpdir(), "biu-project-"));
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

describe("biu extension registration", () => {
	test("is bundled as a built-in extension", () => {
		expect(builtInExtensions.some((extension) => extension.name === "biu")).toBe(true);
	});

	test("registers the command, the tool, and the kickoff message renderer", () => {
		const harness = captureExtension();
		expect(harness.commands.has(BIU_COMMAND_NAME)).toBe(true);
		expect(harness.tool?.name).toBe(BIU_TOOL_NAME);
		expect(harness.renderers.has(BIU_KICKOFF_MESSAGE_TYPE)).toBe(true);
	});
});

describe("biu mode lifecycle", () => {
	test("/biu with arguments only warns", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx, "something");
		expect(context.notifications[0]?.message).toMatch(/Usage/);
		expect(harness.entries).toHaveLength(0);
	});

	test("/biu enables the mode without triggering a turn", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		expect(harness.entries).toEqual([
			{ customType: BIU_MODE_ENTRY_TYPE, data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: true } },
		]);
		expect(harness.activeTools).toContain(BIU_TOOL_NAME);
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("interview");
		expect(context.notifications[0]?.message).toMatch(/Biu Mode on/);
		expect(harness.messages).toHaveLength(0);
		expect(existsSync(getBiuPaths(cwd, agentDir).stateFile)).toBe(true);
	});

	test("session_start replay hides the tool when the mode is off", async () => {
		const harness = captureExtension(["read", BIU_TOOL_NAME]);
		const context = createContext(cwd, []);
		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "startup" }, context.ctx);
		expect(harness.activeTools).not.toContain(BIU_TOOL_NAME);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
	});

	test("session_start replay restores the mode from the branch", async () => {
		const harness = captureExtension(["read"]);
		const enableContext = createContext(cwd);
		await runCommand(harness, enableContext.ctx);

		const restored = captureExtension(["read"]);
		const context = createContext(cwd, [modeEntry(true)]);
		await restored.hooks.get("session_start")?.({ type: "session_start", reason: "resume" }, context.ctx);
		expect(restored.activeTools).toContain(BIU_TOOL_NAME);
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("interview");
	});

	test("replayBiuMode picks the latest flag", () => {
		expect(replayBiuMode([])).toBe(false);
		expect(replayBiuMode([modeEntry(true)])).toBe(true);
		expect(replayBiuMode([modeEntry(true), modeEntry(false)])).toBe(false);
		expect(replayBiuMode([modeEntry(false), { type: "message" }, modeEntry(true)])).toBe(true);
	});

	test("before_agent_start injects the resident block only while enabled", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		const hook = harness.hooks.get("before_agent_start");
		expect(await hook?.({ type: "before_agent_start", systemPrompt: "base" }, context.ctx)).toBeUndefined();

		await runCommand(harness, context.ctx);
		const result = (await hook?.({ type: "before_agent_start", systemPrompt: "base" }, context.ctx)) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt.startsWith("base")).toBe(true);
		expect(result.systemPrompt).toContain("Biu Mode is active");
		expect(result.systemPrompt).toContain("interview");
	});
});

describe("biu menu", () => {
	async function openMenuWith(choice: string): Promise<{ harness: ExtensionHarness; context: ContextHarness }> {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		context.select.mockResolvedValueOnce(choice);
		await runCommand(harness, context.ctx);
		return { harness, context };
	}

	test("Continue sends a visible kickoff message that triggers a turn", async () => {
		const { harness } = await openMenuWith("Continue · interview");
		expect(harness.messages).toHaveLength(1);
		const captured = harness.messages[0];
		expect(captured?.message.customType).toBe(BIU_KICKOFF_MESSAGE_TYPE);
		expect(captured?.message.display).toBe(true);
		expect(captured?.message.content).toContain("interview");
		expect(captured?.options?.triggerTurn).toBe(true);
	});

	test("Exit turns the mode off and keeps files", async () => {
		const { harness, context } = await openMenuWith("Exit Biu Mode");
		expect(harness.entries.at(-1)?.data).toEqual({ schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: false });
		expect(harness.activeTools).not.toContain(BIU_TOOL_NAME);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
		expect(existsSync(getBiuPaths(cwd, agentDir).stateFile)).toBe(true);
	});

	test("Switch stage validates forward transitions", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		context.select.mockResolvedValueOnce("Switch stage…").mockResolvedValueOnce("decompose");
		await runCommand(harness, context.ctx);
		expect(context.notifications.at(-1)?.message).toMatch(/not ready/);
		expect((await loadBiuState(cwd, agentDir))?.stage).toBe("interview");
	});

	test("menu without UI only notifies", async () => {
		const harness = captureExtension(["read"]);
		const enableContext = createContext(cwd);
		await runCommand(harness, enableContext.ctx);
		const context = createContext(cwd, [], false);
		await runCommand(harness, context.ctx);
		expect(context.notifications[0]?.message).toMatch(/interactive UI/);
	});
});

describe("biu tool", () => {
	async function enabledHarness(): Promise<{ harness: ExtensionHarness; context: ContextHarness }> {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		return { harness, context };
	}

	test("refuses to run while the mode is off", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await expect(runTool(harness, context.ctx, { action: "get" })).rejects.toThrow(/not active/);
	});

	test("get returns the snapshot and the current stage playbook", async () => {
		const { harness, context } = await enabledHarness();
		const { text, details } = await runTool(harness, context.ctx, { action: "get" });
		expect(text).toContain("<biu_snapshot>");
		expect(text).toContain("Current stage: interview");
		expect(details.action).toBe("get");
		expect(details.statusLine).toBe("Biu · interview");
	});

	test("drives a full cycle: spec, stage, tasks, execute", async () => {
		const { harness, context } = await enabledHarness();

		await runTool(harness, context.ctx, { action: "spec", title: "OAuth login", baselineCommit: "abc123" });
		await expect(runTool(harness, context.ctx, { action: "stage", to: "decompose" })).rejects.toThrow(/not ready/);

		await runTool(harness, context.ctx, { action: "spec", specStatus: "ready" });
		await runTool(harness, context.ctx, { action: "stage", to: "decompose" });

		await expect(runTool(harness, context.ctx, { action: "stage", to: "execute" })).rejects.toThrow(/no tasks/);
		await runTool(harness, context.ctx, { action: "task", op: "add", id: "TASK-api", taskTitle: "API" });
		await runTool(harness, context.ctx, {
			action: "task",
			op: "add",
			id: "TASK-ui",
			taskTitle: "UI",
			dependsOn: ["TASK-api"],
		});
		await runTool(harness, context.ctx, { action: "stage", to: "execute" });

		const updated = await runTool(harness, context.ctx, {
			action: "task",
			op: "update",
			id: "TASK-api",
			status: "in_progress",
		});
		expect(updated.text).toContain("in_progress");

		const state = await loadBiuState(cwd, agentDir);
		expect(state?.stage).toBe("execute");
		expect(state?.spec).toEqual({ status: "ready", title: "OAuth login", baselineCommit: "abc123" });
		expect(state?.tasks.map((task) => task.id)).toEqual(["TASK-api", "TASK-ui"]);

		// The statusline refreshes through tool_execution_end, not inside execute().
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("interview");
		await harness.hooks.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolName: BIU_TOOL_NAME, isError: false },
			context.ctx,
		);
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("execute 0/2");
	});

	test("validates task operations", async () => {
		const { harness, context } = await enabledHarness();
		await runTool(harness, context.ctx, { action: "task", op: "add", id: "TASK-a", taskTitle: "a" });
		await runTool(harness, context.ctx, {
			action: "task",
			op: "add",
			id: "TASK-b",
			taskTitle: "b",
			dependsOn: ["TASK-a"],
		});

		await expect(
			runTool(harness, context.ctx, { action: "task", op: "add", id: "TASK-a", taskTitle: "x" }),
		).rejects.toThrow(/already exists/);
		await expect(
			runTool(harness, context.ctx, { action: "task", op: "add", id: "bad id", taskTitle: "x" }),
		).rejects.toThrow(/Invalid task id/);
		await expect(
			runTool(harness, context.ctx, { action: "task", op: "update", id: "TASK-a", dependsOn: ["TASK-b"] }),
		).rejects.toThrow(/cycle/);
		await expect(runTool(harness, context.ctx, { action: "task", op: "remove", id: "TASK-a" })).rejects.toThrow(
			/depend/,
		);
		await expect(
			runTool(harness, context.ctx, { action: "task", op: "update", id: "TASK-missing", status: "ready" }),
		).rejects.toThrow(/does not exist/);

		const secondInProgress = await (async () => {
			await runTool(harness, context.ctx, { action: "task", op: "update", id: "TASK-a", status: "in_progress" });
			return runTool(harness, context.ctx, { action: "task", op: "update", id: "TASK-b", status: "in_progress" });
		})();
		expect(secondInProgress.text).toContain("Warning");

		await runTool(harness, context.ctx, { action: "task", op: "update", id: "TASK-b", status: "ready" });
		await runTool(harness, context.ctx, { action: "task", op: "remove", id: "TASK-b" });
		expect((await loadBiuState(cwd, agentDir))?.tasks.map((task) => task.id)).toEqual(["TASK-a"]);
	});

	test("archive requires confirmation for unfinished tasks and resets the cycle", async () => {
		const { harness, context } = await enabledHarness();
		await runTool(harness, context.ctx, { action: "task", op: "add", id: "TASK-a", taskTitle: "a" });

		const paths = getBiuPaths(cwd, agentDir);
		await writeFile(paths.specFile, "# SPEC: Cycle\n", "utf8");
		await writeFile(paths.summaryFile, "# Summary: Cycle\n", "utf8");

		await expect(runTool(harness, context.ctx, { action: "archive", shortname: "cycle" })).rejects.toThrow(
			/confirmIncomplete/,
		);
		const result = await runTool(harness, context.ctx, {
			action: "archive",
			shortname: "cycle",
			confirmIncomplete: true,
		});
		expect(result.details.archivedPath).toBeDefined();
		expect(result.details.state.stage).toBe("interview");
		expect(result.details.state.tasks).toEqual([]);
		expect(existsSync(paths.specFile)).toBe(false);
	});
});
