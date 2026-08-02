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
} from "../src/core/extensions/types.ts";
import biu, {
	BIU_COMMAND_NAME,
	BIU_KICKOFF_MESSAGE_TYPE,
	BIU_MODE_ENTRY_TYPE,
	BIU_MODE_SCHEMA_VERSION,
	BIU_STATUS_KEY,
	replayBiuMode,
} from "../src/extensions/biu/index.ts";
import { getBiuPaths } from "../src/extensions/biu/workspace.ts";
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
}

function captureExtension(): ExtensionHarness {
	const harness: ExtensionHarness = {
		commands: new Map(),
		hooks: new Map(),
		entries: [],
		messages: [],
		renderers: new Map(),
	};
	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => harness.commands.set(name, command),
		registerMessageRenderer: (customType: string, renderer: unknown) => harness.renderers.set(customType, renderer),
		on: (event: string, handler: HookHandler) => harness.hooks.set(event, handler),
		appendEntry: (customType: string, data: unknown) => harness.entries.push({ customType, data }),
		sendMessage: (message: CapturedMessage["message"], options?: CapturedMessage["options"]) =>
			harness.messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	biu(pi);
	return harness;
}

interface ContextHarness {
	ctx: ExtensionCommandContext;
	statuses: Map<string, string | undefined>;
	notifications: Array<{ message: string; level?: string }>;
	select: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	setBranch: (branch: unknown[]) => void;
}

function createContext(cwd: string, initialBranch: unknown[] = [], mode: ExtensionMode = "tui"): ContextHarness {
	let branch = initialBranch;
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const select = vi.fn(async () => undefined as string | undefined);
	const confirm = vi.fn(async () => false);
	const input = vi.fn(async () => undefined as string | undefined);
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
			confirm,
			input,
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		statuses,
		notifications,
		select,
		confirm,
		input,
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

function specContent(status: string, title = "OAuth login"): string {
	return `---\ntitle: ${title}\nstatus: ${status}\nbaseline_commit: abc123\n---\n\n# SPEC: ${title}\n`;
}

async function seedWorkspace(cwd: string, files: Record<string, string>): Promise<void> {
	const paths = getBiuPaths(cwd, agentDir);
	for (const [relative, content] of Object.entries(files)) {
		const target = join(paths.root, relative);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content, "utf8");
	}
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

	test("registers the command and the kickoff message renderer, but no tool", () => {
		const harness = captureExtension();
		expect(harness.commands.has(BIU_COMMAND_NAME)).toBe(true);
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

	test("/biu enables the mode and creates the workspace directories", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		expect(harness.entries).toEqual([
			{ customType: BIU_MODE_ENTRY_TYPE, data: { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: true } },
		]);
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("plan");
		expect(context.notifications[0]?.message).toMatch(/Biu Mode on/);
		expect(harness.messages).toHaveLength(0);
		const paths = getBiuPaths(cwd, agentDir);
		expect(existsSync(paths.tasksDir)).toBe(true);
		expect(existsSync(paths.archivedDir)).toBe(true);
	});

	test("non-TUI commands do not enable Biu Mode", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const modeCwd = join(cwd, mode);
			await mkdir(modeCwd, { recursive: true });
			const harness = captureExtension();
			const context = createContext(modeCwd, [], mode);

			await runCommand(harness, context.ctx);

			expect(context.notifications[0]?.message).toMatch(/interactive TUI/);
			expect(context.select).not.toHaveBeenCalled();
			expect(harness.entries).toHaveLength(0);
			expect(existsSync(getBiuPaths(modeCwd, agentDir).root)).toBe(false);
		}
	});

	test("session_start replay restores the mode from the branch", async () => {
		const harness = captureExtension();
		const context = createContext(cwd, [modeEntry(true)]);
		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "resume" }, context.ctx);
		expect(context.statuses.get(BIU_STATUS_KEY)).toContain("plan");

		const offContext = createContext(cwd, [modeEntry(true), modeEntry(false)]);
		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "resume" }, offContext.ctx);
		expect(offContext.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
	});

	test("non-TUI replay pauses Biu without status or prompt injection", async () => {
		const harness = captureExtension();
		const context = createContext(cwd, [modeEntry(true)], "rpc");

		await harness.hooks.get("session_start")?.({ type: "session_start", reason: "resume" }, context.ctx);

		expect(context.statuses.has(BIU_STATUS_KEY)).toBe(false);
		expect(
			await harness.hooks.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				context.ctx,
			),
		).toBeUndefined();
		expect(harness.entries).toHaveLength(0);
	});

	test("replayBiuMode picks the latest flag", () => {
		expect(replayBiuMode([])).toBe(false);
		expect(replayBiuMode([modeEntry(true)])).toBe(true);
		expect(replayBiuMode([modeEntry(true), modeEntry(false)])).toBe(false);
		expect(replayBiuMode([modeEntry(false), { type: "message" }, modeEntry(true)])).toBe(true);
	});

	test("before_agent_start injects the resident block only while enabled", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const hook = harness.hooks.get("before_agent_start");
		expect(await hook?.({ type: "before_agent_start", systemPrompt: "base" }, context.ctx)).toBeUndefined();

		await runCommand(harness, context.ctx);
		const result = (await hook?.({ type: "before_agent_start", systemPrompt: "base" }, context.ctx)) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt.startsWith("base")).toBe(true);
		expect(result.systemPrompt).toContain("Biu Mode");
		expect(result.systemPrompt).toContain("biu://SPEC.md");
		expect(result.systemPrompt).toContain("Current stage: plan");
	});

	test("resident block follows the workspace stage", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("ready") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		const result = (await harness.hooks.get("before_agent_start")?.(
			{ type: "before_agent_start", systemPrompt: "base" },
			context.ctx,
		)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Current stage: execute");
		expect(result.systemPrompt).toContain("no execution path is recorded");
	});

	test("execute playbook follows the execution frontmatter field", async () => {
		const cases = [
			{ execution: "direct", marker: "implement against it without task files" },
			{ execution: "tasks", marker: "write the task files before touching project code" },
		];
		for (const { execution, marker } of cases) {
			const caseCwd = join(cwd, execution);
			await mkdir(caseCwd, { recursive: true });
			await seedWorkspace(caseCwd, {
				"SPEC.md": `---\ntitle: T\nstatus: ready\nexecution: ${execution}\nbaseline_commit: abc\n---\n\n# SPEC\n`,
			});
			const harness = captureExtension();
			const context = createContext(caseCwd);
			await runCommand(harness, context.ctx);

			const result = (await harness.hooks.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				context.ctx,
			)) as { systemPrompt: string };
			expect(result.systemPrompt).toContain("Current stage: execute");
			expect(result.systemPrompt).toContain(marker);
		}
	});
});

describe("biu:// path resolution", () => {
	test("rewrites biu:// paths for the core file tools", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const hook = harness.hooks.get("tool_call");
		const paths = getBiuPaths(cwd, agentDir);

		for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
			const input: Record<string, unknown> = { path: "biu://SPEC.md" };
			const result = await hook?.({ type: "tool_call", toolName, input }, context.ctx);
			expect(result).toBeUndefined();
			expect(input.path).toBe(paths.specFile);
		}
	});

	test("resolution works without Biu Mode being enabled", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const input: Record<string, unknown> = { path: "biu://tasks/TASK-x.md" };
		await harness.hooks.get("tool_call")?.({ type: "tool_call", toolName: "read", input }, context.ctx);
		expect(input.path).toBe(join(getBiuPaths(cwd, agentDir).tasksDir, "TASK-x.md"));
	});

	test("blocks escaping biu:// paths", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const input: Record<string, unknown> = { path: "biu://../outside.md" };
		const result = (await harness.hooks.get("tool_call")?.(
			{ type: "tool_call", toolName: "write", input },
			context.ctx,
		)) as { block?: boolean; reason?: string };
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/\.\./);
		expect(input.path).toBe("biu://../outside.md");
	});

	test("leaves non-biu paths and other tools untouched", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		const hook = harness.hooks.get("tool_call");

		const plain: Record<string, unknown> = { path: "src/index.ts" };
		expect(await hook?.({ type: "tool_call", toolName: "read", input: plain }, context.ctx)).toBeUndefined();
		expect(plain.path).toBe("src/index.ts");

		const bash: Record<string, unknown> = { command: "cat biu://SPEC.md" };
		expect(await hook?.({ type: "tool_call", toolName: "bash", input: bash }, context.ctx)).toBeUndefined();
		expect(bash.command).toBe("cat biu://SPEC.md");
	});

	test("workspace write results refresh the statusline", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · plan");

		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		await harness.hooks.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "write",
				input: { path: getBiuPaths(cwd, agentDir).specFile },
				content: [],
				isError: false,
			},
			context.ctx,
		);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · plan (draft)");
	});
});

describe("spec ready approval gate", () => {
	async function callWrite(
		harness: ExtensionHarness,
		context: ContextHarness,
		input: Record<string, unknown>,
		toolName = "write",
	): Promise<unknown> {
		return harness.hooks.get("tool_call")?.({ type: "tool_call", toolName, input }, context.ctx);
	}

	test("flipping the SPEC to ready asks for approval and proceeds when approved", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		context.confirm.mockResolvedValueOnce(true);
		const result = await callWrite(harness, context, { path: "biu://SPEC.md", content: specContent("ready") });

		expect(result).toBeUndefined();
		expect(context.confirm).toHaveBeenCalledTimes(1);
		expect(context.confirm.mock.calls[0]?.[0]).toBe("Approve SPEC?");
		expect(context.input).not.toHaveBeenCalled();
	});

	test("rejection blocks the write and carries the feedback", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		context.confirm.mockResolvedValueOnce(false);
		context.input.mockResolvedValueOnce("AC2 is not testable yet");
		const result = (await callWrite(harness, context, {
			path: "biu://SPEC.md",
			content: specContent("ready"),
		})) as { block?: boolean; reason?: string };

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("declined");
		expect(result?.reason).toContain("AC2 is not testable yet");
		expect(result?.reason).toContain("status: draft");
	});

	test("rejection without feedback still blocks with guidance", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		context.confirm.mockResolvedValueOnce(false);
		const result = (await callWrite(harness, context, {
			path: "biu://SPEC.md",
			content: specContent("ready"),
		})) as { block?: boolean; reason?: string };

		expect(result?.block).toBe(true);
		expect(result?.reason).not.toContain("Feedback:");
	});

	test("edit-based transitions trigger the gate too", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		context.confirm.mockResolvedValueOnce(true);
		const result = await callWrite(
			harness,
			context,
			{ path: "biu://SPEC.md", edits: [{ oldText: "status: draft", newText: "status: ready" }] },
			"edit",
		);

		expect(result).toBeUndefined();
		expect(context.confirm).toHaveBeenCalledTimes(1);
	});

	test("no dialog when Biu Mode is off", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);

		const result = await callWrite(harness, context, { path: "biu://SPEC.md", content: specContent("ready") });

		expect(result).toBeUndefined();
		expect(context.confirm).not.toHaveBeenCalled();
	});

	test("no dialog for non-SPEC files or non-transition writes", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("ready") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);

		await callWrite(harness, context, { path: "biu://tasks/TASK-a.md", content: specContent("ready") });
		await callWrite(harness, context, { path: "biu://SPEC.md", content: specContent("ready", "Renamed") });
		await callWrite(harness, context, { path: "src/index.ts", content: "status: ready" });

		expect(context.confirm).not.toHaveBeenCalled();
	});
});

describe("biu menu", () => {
	test("menu shows continue, archive, and exit", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		await runCommand(harness, context.ctx);

		expect(context.select).toHaveBeenCalledTimes(1);
		const [title, options, settings] = context.select.mock.calls[0] ?? [];
		expect(title).toBe("Biu Mode");
		expect((options as Array<{ label: string }>).map((option) => option.label)).toEqual([
			"Continue · plan",
			"Archive cycle",
			"Exit Biu Mode",
		]);
		expect(settings).toEqual({ subtitle: "Biu · plan", cancelHint: "keep Biu Mode active" });
	});

	test("Continue sends a visible kickoff message that triggers a turn", async () => {
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		context.select.mockResolvedValueOnce("Continue · plan");
		await runCommand(harness, context.ctx);

		expect(harness.messages).toHaveLength(1);
		const captured = harness.messages[0];
		expect(captured?.message.customType).toBe(BIU_KICKOFF_MESSAGE_TYPE);
		expect(captured?.message.display).toBe(true);
		expect(captured?.message.content).toContain("plan");
		expect(captured?.options?.triggerTurn).toBe(true);
	});

	test("Exit turns the mode off and keeps files", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("draft") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await runCommand(harness, context.ctx);
		context.select.mockResolvedValueOnce("Exit Biu Mode");
		await runCommand(harness, context.ctx);

		expect(harness.entries.at(-1)?.data).toEqual({ schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: false });
		expect(context.statuses.get(BIU_STATUS_KEY)).toBeUndefined();
		expect(existsSync(getBiuPaths(cwd, agentDir).specFile)).toBe(true);
	});
});

describe("biu archive from the menu", () => {
	async function openArchive(context: ContextHarness, harness: ExtensionHarness): Promise<void> {
		await runCommand(harness, context.ctx);
		context.select.mockResolvedValueOnce("Archive cycle");
		await runCommand(harness, context.ctx);
	}

	test("warns when the summary is missing", async () => {
		await seedWorkspace(cwd, { "SPEC.md": specContent("ready") });
		const harness = captureExtension();
		const context = createContext(cwd);
		await openArchive(context, harness);

		expect(context.notifications.at(-1)?.message).toMatch(/Summary\.md/);
		expect(existsSync(getBiuPaths(cwd, agentDir).specFile)).toBe(true);
	});

	test("archives a complete cycle using the SPEC title as the name", async () => {
		await seedWorkspace(cwd, {
			"SPEC.md": specContent("ready", "OAuth login"),
			"Summary.md": "---\ntitle: Done\nhead_commit: def456\n---\n\n# Summary\n",
			"tasks/TASK-a.md": "---\ntitle: API\nstatus: completed\ndepends_on: []\n---\n\n# TASK-a\n",
		});
		const harness = captureExtension();
		const context = createContext(cwd);
		await openArchive(context, harness);

		expect(context.confirm).not.toHaveBeenCalled();
		expect(context.input).not.toHaveBeenCalled();
		expect(context.notifications.at(-1)?.message).toMatch(/Cycle archived/);
		expect(context.notifications.at(-1)?.message).toContain("OAuth-login");
		const paths = getBiuPaths(cwd, agentDir);
		expect(existsSync(paths.specFile)).toBe(false);
		expect(context.statuses.get(BIU_STATUS_KEY)).toBe("Biu · plan");
	});

	test("unfinished tasks require confirmation and can cancel", async () => {
		await seedWorkspace(cwd, {
			"SPEC.md": specContent("ready"),
			"Summary.md": "---\ntitle: Done\nhead_commit: def456\n---\n\n# Summary\n",
			"tasks/TASK-a.md": "---\ntitle: API\nstatus: in_progress\ndepends_on: []\n---\n\n# TASK-a\n",
		});
		const harness = captureExtension();
		const context = createContext(cwd);
		context.confirm.mockResolvedValueOnce(false);
		await openArchive(context, harness);

		expect(context.confirm).toHaveBeenCalledTimes(1);
		expect(existsSync(getBiuPaths(cwd, agentDir).specFile)).toBe(true);
	});

	test("asks for a name when the SPEC has no usable title", async () => {
		await seedWorkspace(cwd, {
			"SPEC.md": "---\nstatus: ready\nbaseline_commit: abc\n---\n\n# SPEC\n",
			"Summary.md": "---\ntitle: Done\nhead_commit: def456\n---\n\n# Summary\n",
		});
		const harness = captureExtension();
		const context = createContext(cwd);
		context.input.mockResolvedValueOnce("manual-name");
		await openArchive(context, harness);

		expect(context.input).toHaveBeenCalledTimes(1);
		expect(context.notifications.at(-1)?.message).toContain("manual-name");
		expect(existsSync(getBiuPaths(cwd, agentDir).specFile)).toBe(false);
	});
});
