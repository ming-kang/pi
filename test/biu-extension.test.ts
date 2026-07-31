import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionMode,
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
import {
	BIU_TOOL_NAME,
	type BiuToolDetails,
	type BiuToolParams,
	BiuToolParamsSchema,
	normalizeBiuParams,
} from "../src/extensions/biu/tool.ts";
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

function createContext(cwd: string, initialBranch: unknown[] = [], mode: ExtensionMode = "tui"): ContextHarness {
	let branch = initialBranch;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const select = vi.fn(async () => undefined as string | undefined);
	const ctx = {
		cwd,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
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
	const prepared = tool.prepareArguments?.(params) ?? (params as BiuToolParams);
	const result = await tool.execute("call-1", prepared, undefined, undefined, ctx);
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

	test("non-TUI commands do not enable Biu Mode", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const modeCwd = join(cwd, mode);
			await mkdir(modeCwd, { recursive: true });
			const harness = captureExtension(["read"]);
			const context = createContext(modeCwd, [], mode);

			await runCommand(harness, context.ctx);

			expect(context.notifications[0]?.message).toMatch(/interactive TUI/);
			expect(context.select).not.toHaveBeenCalled();
			expect(harness.entries).toHaveLength(0);
			expect(harness.activeTools).not.toContain(BIU_TOOL_NAME);
			expect(existsSync(getBiuPaths(modeCwd, agentDir).stateFile)).toBe(false);
		}
	});

	test("non-TUI replay pauses Biu without status or prompt injection", async () => {
		const harness = captureExtension(["read", BIU_TOOL_NAME]);
		const context = createContext(cwd, [modeEntry(true)], "rpc");

		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "resume" }, context.ctx);

		expect(harness.activeTools).not.toContain(BIU_TOOL_NAME);
		expect(context.statuses.has(BIU_STATUS_KEY)).toBe(false);
		expect(
			await harness.hooks.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				context.ctx,
			),
		).toBeUndefined();
		expect(harness.entries).toHaveLength(0);
	});

	test("returning to TUI restores the preserved branch flag", async () => {
		const harness = captureExtension(["read"]);
		const initial = createContext(cwd);
		await runCommand(harness, initial.ctx);

		const rpcContext = createContext(cwd, [modeEntry(true)], "rpc");
		await harness.hooks.get("session_tree")?.({ type: "session_tree" }, rpcContext.ctx);
		expect(harness.activeTools).not.toContain(BIU_TOOL_NAME);

		const tuiContext = createContext(cwd, [modeEntry(true)]);
		await harness.hooks.get("session_tree")?.({ type: "session_tree" }, tuiContext.ctx);
		expect(harness.activeTools).toContain(BIU_TOOL_NAME);
		expect(tuiContext.statuses.get(BIU_STATUS_KEY)).toContain("interview");
		expect(harness.entries).toHaveLength(1);
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

	test("before_agent_start suggests a fresh workspace when biu.json is missing", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		const otherCwd = join(cwd, "elsewhere");
		await mkdir(otherCwd, { recursive: true });
		const otherContext = createContext(otherCwd);
		const result = (await harness.hooks.get("before_agent_start")?.(
			{ type: "before_agent_start", systemPrompt: "base" },
			otherContext.ctx,
		)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("no biu.json");
		expect(result.systemPrompt).not.toContain("could not be read");
		expect(result.systemPrompt).not.toContain("another directory");
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

	test("menu shows a compact status and only continue and exit", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		await runCommand(harness, context.ctx);

		expect(context.select).toHaveBeenCalledTimes(1);
		const [title, options, settings] = context.select.mock.calls[0] ?? [];
		expect(title).toBe("Biu Mode");
		expect(options).toEqual([
			{ label: "Continue · interview", description: "Start a new turn continuing the current stage" },
			{ label: "Exit Biu Mode", description: "Turn the mode off; workflow files are kept" },
		]);
		expect(settings).toEqual({ subtitle: "interview · SPEC draft", cancelHint: "keep Biu Mode active" });
	});

	test("execute menu status includes progress and active task", async () => {
		const harness = captureExtension(["read"]);
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		await runTool(harness, context.ctx, { action: "spec", title: "Menu status", specStatus: "ready" });
		await runTool(harness, context.ctx, { action: "stage", to: "decompose" });
		await runTool(harness, context.ctx, {
			action: "task",
			op: "add",
			id: "TASK-menu",
			taskTitle: "Update menu",
		});
		await runTool(harness, context.ctx, { action: "stage", to: "execute" });
		await runTool(harness, context.ctx, {
			action: "task",
			op: "update",
			id: "TASK-menu",
			status: "in_progress",
		});

		await runCommand(harness, context.ctx);

		const [, options, settings] = context.select.mock.calls[0] ?? [];
		expect(settings?.subtitle).toBe("execute · 0/1 done · active TASK-menu");
		expect(options?.[0]?.description).toBe("Active: TASK-menu · Update menu");
	});

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

	test("task id and dependency schema bounds match the id format", () => {
		const idSchema = BiuToolParamsSchema.properties.id as { maxLength?: number };
		const dependsOnSchema = BiuToolParamsSchema.properties.dependsOn as { items?: { maxLength?: number } };
		expect(idSchema.maxLength).toBe(85);
		expect(dependsOnSchema.items?.maxLength).toBe(85);
	});

	test("normalizes provider-filled arguments by action", () => {
		const defaults = {
			specStatus: "draft",
			title: "",
			baselineCommit: "",
			op: "add",
			id: "",
			taskTitle: "",
			status: "ready",
			dependsOn: [],
			to: "interview",
			shortname: "",
			confirmIncomplete: false,
		};

		expect(normalizeBiuParams({ action: "get", ...defaults })).toEqual({ action: "get" });
		expect(
			normalizeBiuParams({
				action: "spec",
				...defaults,
				specStatus: "ready",
				title: "OAuth",
				baselineCommit: "abc123",
			}),
		).toEqual({ action: "spec", specStatus: "ready", title: "OAuth", baselineCommit: "abc123" });
		expect(
			normalizeBiuParams({
				action: "task",
				...defaults,
				op: "add",
				id: "TASK-api",
				taskTitle: "API",
			}),
		).toEqual({ action: "task", op: "add", id: "TASK-api", taskTitle: "API", dependsOn: [] });
		expect(
			normalizeBiuParams({
				action: "task",
				...defaults,
				op: "update",
				id: "TASK-api",
				status: "in_progress",
			}),
		).toEqual({ action: "task", op: "update", id: "TASK-api", status: "in_progress", dependsOn: [] });
		expect(normalizeBiuParams({ action: "task", ...defaults, op: "remove", id: "TASK-api" })).toEqual({
			action: "task",
			op: "remove",
			id: "TASK-api",
		});
		expect(normalizeBiuParams({ action: "stage", ...defaults, to: "execute" })).toEqual({
			action: "stage",
			to: "execute",
		});
		expect(normalizeBiuParams({ action: "archive", ...defaults, shortname: "oauth" })).toEqual({
			action: "archive",
			shortname: "oauth",
			confirmIncomplete: false,
		});
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

	test("provider-filled task add accepts the neutral ready status", async () => {
		const { harness, context } = await enabledHarness();
		const result = await runTool(harness, context.ctx, {
			action: "task",
			specStatus: "draft",
			title: "",
			baselineCommit: "",
			op: "add",
			id: "TASK-provider",
			taskTitle: "Provider-compatible task",
			status: "ready",
			dependsOn: [],
			to: "interview",
			shortname: "",
			confirmIncomplete: false,
		});

		expect(result.text).toContain("TASK-provider added");
		expect((await loadBiuState(cwd, agentDir))?.tasks).toEqual([
			{ id: "TASK-provider", title: "Provider-compatible task", status: "ready", dependsOn: [] },
		]);
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
			runTool(harness, context.ctx, {
				action: "task",
				op: "add",
				id: "TASK-c",
				taskTitle: "c",
				status: "in_progress",
			}),
		).rejects.toThrow(/always start as "ready"/);
		await expect(
			runTool(harness, context.ctx, {
				action: "task",
				op: "add",
				id: "TASK-c",
				taskTitle: "c",
				status: "completed",
			}),
		).rejects.toThrow(/always start as "ready"/);
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
