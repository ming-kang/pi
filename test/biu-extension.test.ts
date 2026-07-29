import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "../src/core/extensions/types.ts";
import biu, {
	BIU_COMMAND_NAME,
	BIU_KICKOFF_MESSAGE_TYPE,
	BIU_MODE_ENTRY_TYPE,
	BIU_MODE_SCHEMA_VERSION,
	BIU_STATUS_KEY,
	replayBiuMode,
} from "../src/extensions/biu/index.ts";
import { getBiuWorkspacePaths } from "../src/extensions/biu/storage.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

type HookHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface CapturedEntry {
	customType: string;
	data: unknown;
}

interface CapturedMessage {
	message: { customType: string; content: string; display?: boolean };
	options?: { triggerTurn?: boolean };
}

interface ExtensionHarness {
	commands: Map<string, RegisteredCommand>;
	hooks: Map<string, HookHandler>;
	entries: CapturedEntry[];
	messages: CapturedMessage[];
	registeredToolCount: number;
}

interface ContextHarness {
	ctx: ExtensionCommandContext;
	statuses: Map<string, string | undefined>;
	notifications: Array<{ message: string; level?: string }>;
	select: ReturnType<typeof vi.fn>;
	setBranch: (branch: unknown[]) => void;
	waitForIdle: ReturnType<typeof vi.fn>;
}

function captureExtension(): ExtensionHarness {
	const commands = new Map<string, RegisteredCommand>();
	const hooks = new Map<string, HookHandler>();
	const entries: CapturedEntry[] = [];
	const messages: CapturedMessage[] = [];
	let registeredToolCount = 0;
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		registerTool: () => {
			registeredToolCount++;
		},
		on: (event: string, handler: HookHandler) => hooks.set(event, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendMessage: (message: CapturedMessage["message"], options?: CapturedMessage["options"]) =>
			messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	biu(pi);
	return {
		commands,
		hooks,
		entries,
		messages,
		get registeredToolCount() {
			return registeredToolCount;
		},
	};
}

function createContext(cwd: string, initialBranch: unknown[] = [], hasUI = true): ContextHarness {
	let branch = initialBranch;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const select = vi.fn(async () => undefined as string | undefined);
	const waitForIdle = vi.fn(async () => {});
	const ctx = {
		cwd,
		hasUI,
		waitForIdle,
		sessionManager: {
			getBranch: () => branch,
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
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
		waitForIdle,
	};
}

function modeEntry(enabled: boolean): unknown {
	return {
		type: "custom",
		customType: BIU_MODE_ENTRY_TYPE,
		data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled },
	};
}

const READY_SPEC = `---
title: Runtime test
status: ready
---

## Open Questions
- [x] Confirmed

## Acceptance Criteria
- [ ] AC1: Runtime works
`;

const COMPLETED_TASK = `---
id: TASK-runtime
title: Complete runtime
status: completed
depends_on: []
---

## Covers
- AC1
`;

describe("Biu extension", () => {
	let root = "";
	let cwd = "";
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-biu-extension-"));
		cwd = join(root, "project");
		await mkdir(cwd, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(root, "agent");
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		await rm(root, { force: true, recursive: true });
	});

	test("is a hidden built-in with one argument-free command and no model-facing tool", () => {
		const harness = captureExtension();
		expect(builtInExtensions).toContainEqual(expect.objectContaining({ name: "biu", hidden: true }));
		expect(harness.commands.get(BIU_COMMAND_NAME)?.description).toContain("manage the project Biu workflow");
		expect(harness.commands.get(BIU_COMMAND_NAME)?.getArgumentCompletions).toBeUndefined();
		expect(harness.registeredToolCount).toBe(0);
		expect([...harness.hooks.keys()]).toEqual([
			"before_agent_start",
			"agent_settled",
			"session_start",
			"session_tree",
			"session_shutdown",
		]);
	});

	test("/biu enters once and a second invocation opens the menu without an implicit turn", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const command = harness.commands.get(BIU_COMMAND_NAME);
		expect(command).toBeDefined();

		await command?.handler("", context.ctx);
		const paths = getBiuWorkspacePaths(cwd);
		expect(existsSync(paths.tasks)).toBe(true);
		expect(existsSync(paths.archived)).toBe(true);
		expect(existsSync(join(cwd, ".biu"))).toBe(false);
		expect(context.waitForIdle).toHaveBeenCalledOnce();
		expect(harness.entries).toEqual([
			{
				customType: BIU_MODE_ENTRY_TYPE,
				data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: true },
			},
		]);
		expect(harness.messages).toEqual([
			{
				message: expect.objectContaining({ customType: BIU_KICKOFF_MESSAGE_TYPE, display: false }),
				options: { triggerTurn: true },
			},
		]);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · interview");

		const promptResult = (await harness.hooks.get("before_agent_start")?.({ systemPrompt: "BASE" }, context.ctx)) as {
			systemPrompt?: string;
		};
		expect(promptResult.systemPrompt).toContain("BASE\n\nYou are operating in Biu Mode");
		expect(promptResult.systemPrompt).toContain('"stage": "interview"');
		expect(promptResult.systemPrompt).toContain(JSON.stringify(paths.root));
		expect(promptResult.systemPrompt).toContain("Never create, read, or migrate a project-local .biu directory");

		await command?.handler("", context.ctx);
		expect(harness.entries).toHaveLength(1);
		expect(harness.messages).toHaveLength(1);
		expect(context.select).toHaveBeenCalledOnce();
		expect(context.select).toHaveBeenCalledWith(
			"Biu Mode",
			[
				{
					label: "Continue · interview",
					description: "Start a new agent turn for the inferred stage",
				},
				{
					label: "Show status",
					description: "Show the workspace, task counts, and bounded diagnostics",
				},
				{
					label: "Exit Biu Mode",
					description: "Disable the mode without changing workflow files",
				},
			],
			{ subtitle: "Biu · interview", cancelHint: "keep Biu Mode active" },
		);
	});

	test("the active menu can continue the inferred stage without duplicating enabled state", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const command = harness.commands.get(BIU_COMMAND_NAME);
		await command?.handler("", context.ctx);
		context.select.mockResolvedValueOnce("Continue · interview");
		await command?.handler("", context.ctx);

		expect(harness.entries).toHaveLength(1);
		expect(harness.messages).toHaveLength(2);
		expect(harness.messages.at(-1)).toEqual({
			message: expect.objectContaining({ customType: BIU_KICKOFF_MESSAGE_TYPE, display: false }),
			options: { triggerTurn: true },
		});
	});

	test("the active menu shows a bounded status snapshot", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const command = harness.commands.get(BIU_COMMAND_NAME);
		await command?.handler("", context.ctx);
		context.notifications.length = 0;
		context.select.mockResolvedValueOnce("Show status");
		await command?.handler("", context.ctx);

		expect(harness.entries).toHaveLength(1);
		expect(harness.messages).toHaveLength(1);
		expect(context.notifications.at(-1)?.message).toContain("Biu · interview");
		expect(context.notifications.at(-1)?.message).toContain("Workspace:");
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · interview");
	});

	test("the active menu exits explicitly and removes prompt injection", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const command = harness.commands.get(BIU_COMMAND_NAME);
		await command?.handler("", context.ctx);
		context.select.mockResolvedValueOnce("Exit Biu Mode");
		await command?.handler("", context.ctx);

		expect(harness.entries.at(-1)).toEqual({
			customType: BIU_MODE_ENTRY_TYPE,
			data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: false },
		});
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
		expect(context.notifications.at(-1)?.message).toContain("Workflow files were left unchanged");
		await expect(
			harness.hooks.get("before_agent_start")?.({ systemPrompt: "BASE" }, context.ctx),
		).resolves.toBeUndefined();
	});

	test("an active non-UI session reports that the menu is unavailable", async () => {
		const harness = captureExtension();
		const context = createContext(cwd, [], false);
		const command = harness.commands.get(BIU_COMMAND_NAME);
		await command?.handler("", context.ctx);
		await command?.handler("", context.ctx);

		expect(context.select).not.toHaveBeenCalled();
		expect(harness.entries).toHaveLength(1);
		expect(harness.messages).toHaveLength(1);
		expect(context.notifications.at(-1)).toEqual({
			message: "The Biu menu requires an interactive UI.",
			level: "warning",
		});
	});

	test("rejects command arguments before changing state", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await harness.commands.get(BIU_COMMAND_NAME)?.handler("off", context.ctx);
		expect(context.waitForIdle).not.toHaveBeenCalled();
		expect(harness.entries).toHaveLength(0);
		expect(harness.messages).toHaveLength(0);
		expect(context.notifications).toEqual([{ message: "Usage: /biu", level: "warning" }]);
	});

	test("restores branch-aware mode and refreshes the inferred stage", async () => {
		const harness = captureExtension();
		const context = createContext(cwd, [modeEntry(true)]);
		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "reload" }, context.ctx);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · interview");
		await harness.commands.get(BIU_COMMAND_NAME)?.handler("", context.ctx);
		expect(context.select).toHaveBeenCalledOnce();
		expect(harness.entries).toHaveLength(0);
		expect(harness.messages).toHaveLength(0);

		const paths = getBiuWorkspacePaths(cwd);
		expect(existsSync(paths.tasks)).toBe(true);
		await writeFile(paths.spec, READY_SPEC, "utf8");
		await rm(paths.tasks, { recursive: true });
		await harness.hooks.get("agent_settled")?.({ type: "agent_settled" }, context.ctx);
		expect(existsSync(paths.tasks)).toBe(true);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · decompose");
		const promptResult = (await harness.hooks.get("before_agent_start")?.({ systemPrompt: "BASE" }, context.ctx)) as {
			systemPrompt?: string;
		};
		expect(promptResult.systemPrompt).toContain('"stage": "decompose"');

		await writeFile(join(paths.tasks, "TASK-runtime.md"), COMPLETED_TASK, "utf8");
		const archivePrompt = (await harness.hooks.get("before_agent_start")?.(
			{ systemPrompt: "BASE" },
			context.ctx,
		)) as { systemPrompt?: string };
		expect(archivePrompt.systemPrompt).toContain('"stage": "archive"');
		expect(archivePrompt.systemPrompt).toContain("archived/YYYY-MM-DD-shortname/");
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · archive 1/1");

		context.setBranch([modeEntry(true), modeEntry(false)]);
		await harness.hooks.get("session_tree")?.({ type: "session_tree" }, context.ctx);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
		await expect(
			harness.hooks.get("before_agent_start")?.({ systemPrompt: "BASE" }, context.ctx),
		).resolves.toBeUndefined();

		await harness.hooks.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
	});

	test("swallows stale lifecycle contexts", async () => {
		const harness = captureExtension();
		const staleContext = {
			get sessionManager(): never {
				throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
			},
		} as unknown as ExtensionContext;
		await expect(
			harness.hooks.get("session_start")?.({ type: "session_start" }, staleContext),
		).resolves.toBeUndefined();
	});
});

describe("Biu mode replay", () => {
	test("uses the latest valid branch entry", () => {
		expect(
			replayBiuMode([
				modeEntry(true),
				{ type: "custom", customType: BIU_MODE_ENTRY_TYPE, data: { schemaVersion: 99, enabled: false } },
				{ type: "custom", customType: "other", data: { enabled: false } },
			]),
		).toBe(true);
		expect(replayBiuMode([modeEntry(true), modeEntry(false)])).toBe(false);
	});

	test("defaults to disabled without a valid entry", () => {
		expect(replayBiuMode([])).toBe(false);
		expect(replayBiuMode([{ type: "custom", customType: BIU_MODE_ENTRY_TYPE, data: { enabled: true } }])).toBe(false);
	});
});
