import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai/compat";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/core/sdk.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { TASK_RECORD_TYPE } from "../src/core/tasks/codec.ts";
import { projectForModel } from "../src/core/tasks/presentation.ts";
import { createAgentTool } from "../src/extensions/agent/index.ts";
import tasksExtension from "../src/extensions/tasks/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

let harness: Harness;
/** Background work needs the tasks management tool, so these sessions load the Tasks extension. */
async function createBackgroundHarness(options: Parameters<typeof createHarness>[0] = {}) {
	const created = await createHarness({ ...options, extensionFactories: [tasksExtension] });
	await created.session.bindExtensions({ tasksEnabled: true });
	return created;
}
const sessionRoots: string[] = [];
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
	for (const root of sessionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A harness whose main session is saved to disk, so Agents keep artifacts beside it. */
async function createSavedHarness(options: Parameters<typeof createHarness>[0] = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-saved-"));
	sessionRoots.push(root);
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	sessionManager.appendMessage({ role: "user", content: "Start", timestamp: 1 });
	return createHarness({ settings: { compaction: { enabled: false } }, ...options, sessionManager });
}

function runAgent(id: string, prompt = "Do the work") {
	return createAgentTool().execute(
		id,
		{ prompt },
		undefined,
		undefined,
		harness.session.extensionRunner.createToolContext(id, undefined),
	);
}

describe("Agent delegation", () => {
	it("uses an isolated coding session and returns its report with usage and Tasks details", async () => {
		harness = await createHarness({ settings: { compaction: { enabled: false } } });
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;\n");
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
					"read",
					"bash",
					"edit",
					"write",
				]);
				expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_PARENT_CONVERSATION");
				return fauxAssistantMessage(fauxToolCall("read", { path: "entry.ts" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("## Report\nentry.ts:1 exports `answer = 42`."),
		]);
		harness.sessionManager.appendMessage({ role: "user", content: "PRIVATE_PARENT_CONVERSATION", timestamp: 1 });
		const result = await createAgentTool().execute(
			"agent-call",
			{ prompt: "Inspect entry.ts and report the export", description: "Inspect entry" },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("agent-call", undefined),
		);
		expect(getMessageText(result)).toContain("entry.ts:1");
		expect(result.details).toEqual({ version: 2, state: "completed", taskId: expect.any(String) });
		const task = harness.session.tasks.list()[0]!;
		expect(task).toMatchObject({
			kind: "agent",
			label: "Agent",
			output: "report",
			title: "Inspect entry",
			status: "completed",
			input: { label: "Prompt", text: "Inspect entry.ts and report the export" },
		});
		expect(task.facts).toContainEqual(["Model", `${harness.models[0]!.provider}/${harness.models[0]!.id}`]);
		// A settled Agent publishes no display, so /tasks shows its report alone.
		expect(task.display).toBeUndefined();
		expect(task.result?.text).toContain("entry.ts:1 exports");
		expect(task.outputPath).toBeUndefined();
		// An unsaved session keeps no artifacts: counts only, no report or transcript rows.
		expect(task.facts?.map(([label]) => label)).toEqual(["Model", "Thinking", "Directory", "Tool calls"]);
		expect(task.facts).toContainEqual(["Tool calls", "1"]);
		expect((await harness.session.tasks.read(task.id)).text).toContain("## Report");
		const records = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === TASK_RECORD_TYPE ? [entry.data] : []));
		expect(records).toEqual([expect.objectContaining({ task: expect.objectContaining({ id: task.id }) })]);
		expect(records[0]).toHaveProperty("usage.totalTokens");
	});

	it("preserves an oversized report as managed output and returns a bounded preview", async () => {
		harness = await createHarness({ settings: { compaction: { enabled: false } } });
		const report = `## Report\n\nSTART\n${"🙂".repeat(7000)}\nEND`;
		harness.setResponses([fauxAssistantMessage(report)]);
		const result = await createAgentTool().execute(
			"long-report",
			{ prompt: "Return the requested report" },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("long-report", undefined),
		);
		const text = getMessageText(result);
		expect(text).toContain("Agent output truncated. Full output:");
		expect(text).not.toContain("�");
		expect(text.length).toBeLessThan(report.length);
		const outputPath = text.match(/Full output: ([^\]\r\n]+)/)?.[1];
		expect(outputPath).toBeDefined();
		expect(readFileSync(outputPath!, "utf8")).toBe(report);
		const task = harness.session.tasks.list()[0]!;
		expect(task.outputPath).toBe(outputPath);
		const tail = await harness.session.tasks.read(task.id, { mode: "tail", bytes: 1024 });
		expect(tail.totalBytes).toBe(Buffer.byteLength(report));
		expect(tail.text).toContain("END");
		harness.session.dispose();
		await vi.waitFor(() => expect(existsSync(outputPath!)).toBe(false));
	});

	it("keeps an oversized background report available after handoff", async () => {
		harness = await createBackgroundHarness({ settings: { compaction: { enabled: false } } });
		const resumeNotifications = harness.session.pauseTaskNotifications();
		try {
			const report = `BACKGROUND\n${"x".repeat(26 * 1024)}`;
			harness.setResponses([fauxAssistantMessage(report)]);
			const handoff = await createAgentTool().execute(
				"background-report",
				{ prompt: "Return the requested report", background: true },
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext("background-report", undefined),
			);
			expect(handoff.details?.state).toBe("background");
			const taskId = handoff.details?.taskId;
			expect(taskId).toBeDefined();
			const task = (await harness.session.tasks.wait(taskId!)).task;
			expect(task.status).toBe("completed");
			expect(task.outputPath).toBeDefined();
			expect(readFileSync(task.outputPath!, "utf8")).toBe(report);
			// The notification leads with the report's beginning, as a foreground result would.
			expect(projectForModel(task)).toContain("BACKGROUND");
		} finally {
			resumeNotifications();
		}
	});

	it("reads a one-line status while running and keeps tool activity for the human Output view", async () => {
		harness = await createBackgroundHarness({ settings: { compaction: { enabled: false } } });
		harness.session.pauseTaskNotifications();
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;\n");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "text", text: "Found the export in entry.ts." }, fauxToolCall("read", { path: "entry.ts" })],
				{
					stopReason: "toolUse",
				},
			),
			async () => {
				await gate;
				return fauxAssistantMessage("Final report");
			},
		]);
		const handoff = await createAgentTool().execute(
			"text-projection",
			{ prompt: "Inspect entry.ts", background: true },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("text-projection", undefined),
		);
		const taskId = handoff.details!.taskId;
		await vi.waitFor(() => expect(harness.session.tasks.get(taskId).display?.text).toMatch(/^✓ read entry.ts · /u));
		const running = await harness.session.tasks.read(taskId);
		expect(running.text).toBe("Agent running · 1 tool call · latest: read entry.ts");
		// The panel gets the same call styled and fitted, from the live execution.
		initTheme("dark");
		const live = harness.session.tasks.presentOutput(taskId, 60, theme);
		expect(live?.map(stripTerminalSequences)).toEqual([expect.stringMatching(/^✓ read entry\.ts · \d+ms$/u)]);
		expect(live?.[0]).toContain("\u001b[");
		release();
		expect((await harness.session.tasks.wait(taskId)).task.status).toBe("completed");
		expect((await harness.session.tasks.read(taskId)).text).toBe("Final report");
		const settled = harness.session.tasks.get(taskId);
		expect(settled.display).toBeUndefined();
		expect(settled.result?.text).toBe("Final report");
		expect(harness.session.tasks.presentOutput(taskId, 60, theme)).toBeUndefined();
	});

	it("publishes aligned tool calls with relative targets and one-line errors while running", async () => {
		harness = await createBackgroundHarness({ settings: { compaction: { enabled: false } } });
		harness.session.pauseTaskNotifications();
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;\n");
		const outside = join(process.cwd(), "package.json");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: join(harness.tempDir, "entry.ts") }),
					fauxToolCall("read", { path: outside }),
					fauxToolCall("bash", { command: "echo first line; echo second line; exit 3" }),
				],
				{ stopReason: "toolUse" },
			),
			async () => {
				await gate;
				return fauxAssistantMessage("Final report");
			},
		]);
		const handoff = await createAgentTool().execute(
			"running-display",
			{ prompt: "Inspect entry.ts", background: true },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("running-display", undefined),
		);
		const taskId = handoff.details!.taskId;
		await vi.waitFor(() => expect(harness.session.tasks.get(taskId).display?.text).toMatch(/✗ bash .* · \d+ms\n/u));
		const lines = harness.session.tasks.get(taskId).display!.text.split("\n");
		expect(lines[0]).toMatch(/^✓ read entry\.ts · \d+ms$/u);
		expect(lines[1]).toMatch(/^✓ read /u);
		expect(lines[1]).toContain(outside);
		expect(lines[2]).toMatch(/^✗ bash echo first line; echo second line; exit 3 · \d+ms$/u);
		expect(lines[3]).toMatch(/^ {7}\S/u);
		expect(lines[3]).not.toContain("\n");
		expect(lines).toHaveLength(4);
		// The styled list carries the same rows, clipped to the width it is given.
		initTheme("dark");
		expect(harness.session.tasks.presentOutput(taskId, 200, theme)?.map(stripTerminalSequences)).toEqual(lines);
		for (const line of harness.session.tasks.presentOutput(taskId, 30, theme) ?? [])
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		release();
		await harness.session.tasks.wait(taskId);
	});

	it("settles a failed Agent with its diagnostic as the result and no display", async () => {
		harness = await createBackgroundHarness({ settings: { compaction: { enabled: false } } });
		harness.session.pauseTaskNotifications();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo working" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Partial findings", { stopReason: "error", errorMessage: "Model unavailable" }),
		]);
		const handoff = await createAgentTool().execute(
			"failed-agent",
			{ prompt: "Inspect entry.ts", background: true },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("failed-agent", undefined),
		);
		const taskId = handoff.details!.taskId;
		expect((await harness.session.tasks.wait(taskId)).task.status).toBe("failed");
		const task = harness.session.tasks.get(taskId);
		expect(task.display).toBeUndefined();
		expect(task.result?.text).toContain("Partial findings");
		expect(task.result?.text).toContain("Model unavailable");
		expect(task.facts).toContainEqual(["Tool calls", "1"]);
	});

	it("honors declined project trust without dropping repository instructions", async () => {
		harness = await createHarness();
		harness.settingsManager.setProjectTrusted(false);
		const piDir = join(harness.tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(join(piDir, "SYSTEM.md"), "UNTRUSTED_SYSTEM_PROMPT");
		writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "UNTRUSTED_APPEND_PROMPT");
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "REPOSITORY_INSTRUCTIONS");
		writeFileSync(join(piDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 12345, transport: "sse" }));
		let contextText = "";
		let requestOptions: unknown;
		harness.setResponses([
			(context, options) => {
				contextText = JSON.stringify(context.messages);
				requestOptions = options;
				return fauxAssistantMessage("Report");
			},
		]);
		await createAgentTool().execute(
			"untrusted",
			{ prompt: "Inspect the repository" },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("untrusted", undefined),
		);
		expect(contextText).toContain("REPOSITORY_INSTRUCTIONS");
		expect(contextText).not.toContain("UNTRUSTED_SYSTEM_PROMPT");
		expect(contextText).not.toContain("UNTRUSTED_APPEND_PROMPT");
		expect(requestOptions).toMatchObject({
			timeoutMs: harness.settingsManager.getHttpIdleTimeoutMs(),
			transport: harness.settingsManager.getTransport(),
		});
	});

	it("keeps trusted project request settings through worker initialization", async () => {
		harness = await createHarness();
		const piDir = join(harness.tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(
			join(piDir, "settings.json"),
			JSON.stringify({ httpIdleTimeoutMs: 12345, transport: "sse", compaction: { enabled: false } }),
		);
		let requestOptions: unknown;
		harness.setResponses([
			(_context, options) => {
				requestOptions = options;
				return fauxAssistantMessage("Report");
			},
		]);
		await createAgentTool().execute(
			"project-settings",
			{ prompt: "Inspect the repository" },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("project-settings", undefined),
		);
		expect(requestOptions).toMatchObject({ timeoutMs: 12345, transport: "sse" });
	});

	it("applies trusted project shell settings before building the worker tools", async () => {
		harness = await createHarness();
		const piDir = join(harness.tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(
			join(piDir, "settings.json"),
			JSON.stringify({ shellCommandPrefix: 'export AGENT_PROJECT_PREFIX="configured"' }),
		);
		let shellOutput = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: 'printf "%s" "$AGENT_PROJECT_PREFIX"' }), {
				stopReason: "toolUse",
			}),
			(context) => {
				shellOutput = getMessageText(context.messages.findLast((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Report");
			},
		]);
		await createAgentTool().execute(
			"shell-settings",
			{ prompt: "Verify the shell configuration" },
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("shell-settings", undefined),
		);
		expect(shellOutput).toContain("configured");
	});

	it.each(["startup update", "prompt preflight"])(
		"does not request a model or write files after cancellation during %s",
		async (stage) => {
			harness = await createHarness();
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "cancelled.txt", content: "Should not be written" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Wrote the file"),
			]);
			const parent = new AbortController();
			const result = await createAgentTool().execute(
				"early-cancel",
				{ prompt: "Write a file" },
				parent.signal,
				() => {
					if (stage === "startup update") parent.abort();
					else queueMicrotask(() => parent.abort());
				},
				harness.session.extensionRunner.createToolContext("early-cancel", parent.signal),
			);
			expect(result.details?.state).toBe("cancelled");
			expect(harness.session.tasks.list()[0]?.status).toBe("cancelled");
			expect(harness.session.tasks.list()[0]?.display).toBeUndefined();
			expect(harness.faux.state.callCount).toBe(0);
			expect(existsSync(join(harness.tempDir, "cancelled.txt"))).toBe(false);
		},
	);

	it("disposes a child created just before initialization cancellation wins", async () => {
		harness = await createHarness();
		const parent = new AbortController();
		const createSession = sdk.createAgentSession;
		let child: Harness["session"] | undefined;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options) => {
			const created = await createSession(options);
			child = created.session;
			queueMicrotask(() => queueMicrotask(() => parent.abort()));
			return created;
		});
		harness.setResponses([fauxAssistantMessage("Should not run")]);
		const result = await createAgentTool().execute(
			"initialization-cancel",
			{ prompt: "Inspect the repository" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createToolContext("initialization-cancel", parent.signal),
		);
		expect(result.details?.state).toBe("cancelled");
		expect(harness.faux.state.callCount).toBe(0);
		expect(child).toBeDefined();
		expect(() => child!.extensionRunner.createContext().getExtensionSettings("agent")).toThrow(/stale/);
	});

	it("cancels a foreground request and preserves its partial report", async () => {
		harness = await createHarness();
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;");
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: "Found entry.ts" }, fauxToolCall("read", { path: "entry.ts" })], {
				stopReason: "toolUse",
			}),
			(_context, options) =>
				new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				}),
		]);
		const parent = new AbortController();
		const running = createAgentTool().execute(
			"cancel",
			{ prompt: "Investigate" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createToolContext("cancel", parent.signal),
		);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
		parent.abort();
		const result = await running;
		expect(result.details?.state).toBe("cancelled");
		const task = harness.session.tasks.list()[0]!;
		expect(task.status).toBe("cancelled");
		expect(task.result?.text).toContain("Found entry.ts");
		expect(task.facts).toContainEqual(["Tool calls", "1"]);
	});

	it("continues the same Agent after foreground handoff and parent cancellation", async () => {
		harness = await createBackgroundHarness();
		const resumeNotifications = harness.session.pauseTaskNotifications();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("Final report");
			},
		]);
		const parent = new AbortController();
		const running = createAgentTool().execute(
			"handoff",
			{ prompt: "Investigate" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createToolContext("handoff", parent.signal),
		);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		const task = harness.session.tasks.list()[0]!;
		expect(harness.session.tasks.detach(task.id)).toBe(true);
		const handoff = await running;
		expect(handoff.details).toMatchObject({ state: "background", byUser: true });
		expect(getMessageText(handoff)).toContain(task.id);
		parent.abort();
		release();
		expect((await harness.session.tasks.wait(task.id)).task.status).toBe("completed");
		expect(harness.faux.state.callCount).toBe(1);
		resumeNotifications();
	});

	it("keeps parallel calls independent and exposes lane waiting as queued Tasks", async () => {
		harness = await createHarness({ settings: { compaction: { enabled: false } } });
		const releases: Array<() => void> = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				const prompt = context.messages.findLast((message) => message.role === "user");
				return new Promise((resolve) => {
					releases.push(() => resolve(fauxAssistantMessage(`Report: ${getMessageText(prompt)}`)));
				});
			}),
		);
		const tool = createAgentTool({ concurrency: 1 });
		const calls = ["one", "two", "three"].map((name) =>
			tool.execute(
				name,
				{ prompt: name, description: name },
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext(name, undefined),
			),
		);
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		expect(
			harness.session.tasks
				.list()
				.map((task) => task.status)
				.sort(),
		).toEqual(["queued", "queued", "running"]);
		for (let index = 0; index < 3; index++) {
			await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
			releases[index]!();
		}
		const results = await Promise.all(calls);
		expect(results.map(getMessageText)).toEqual(["Report: one", "Report: two", "Report: three"]);
		expect(new Set(harness.session.tasks.list().map((task) => task.id)).size).toBe(3);
		expect(harness.session.tasks.list().every((task) => task.status === "completed")).toBe(true);
	});

	it("returns a queued background Agent immediately and starts it when a slot frees", async () => {
		harness = await createBackgroundHarness({ settings: { compaction: { enabled: false } } });
		harness.session.pauseTaskNotifications();
		let releaseFirst!: () => void;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					releaseFirst = () => resolve(fauxAssistantMessage("First report"));
				}),
			fauxAssistantMessage("Queued report"),
		]);
		const tool = createAgentTool({ concurrency: 1 });
		const context = (id: string) => harness.session.extensionRunner.createToolContext(id, undefined);
		const first = tool.execute("first", { prompt: "first" }, undefined, undefined, context("first"));
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		const queued = await tool.execute(
			"queued",
			{ prompt: "queued", background: true },
			undefined,
			undefined,
			context("queued"),
		);
		expect(queued.details).toMatchObject({ state: "background", byUser: false });
		expect(getMessageText(queued)).toContain("queued until an Agent slot frees");
		const taskId = queued.details!.taskId;
		expect(harness.session.tasks.get(taskId).status).toBe("queued");
		releaseFirst();
		expect(getMessageText(await first)).toBe("First report");
		expect((await harness.session.tasks.wait(taskId)).task.status).toBe("completed");
		expect((await harness.session.tasks.read(taskId)).text).toBe("Queued report");
	});

	it("fails an unavailable configured model before accepting background work", async () => {
		harness = await createBackgroundHarness();
		const ctx = harness.session.extensionRunner.createToolContext("invalid", undefined);
		await ctx.setExtensionSettings("agent", { model: "missing/model" });
		await expect(
			createAgentTool().execute("invalid", { prompt: "Investigate", background: true }, undefined, undefined, ctx),
		).rejects.toThrow(/model/i);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.tasks.list()).toEqual([]);
	});
});

describe("Agent artifacts in a saved session", () => {
	const writeCall = (path: string, content = "export {};\n") => fauxToolCall("write", { path, content });
	const taskFact = (label: string) => harness.session.tasks.list()[0]?.facts?.find(([name]) => name === label)?.[1];

	it("keeps the report and a linked transcript, and reports calls and edited files", async () => {
		harness = await createSavedHarness();
		const mainFile = harness.sessionManager.getSessionFile()!;
		harness.setResponses([
			fauxAssistantMessage(
				[writeCall("a.ts", "export const a = 1;\n"), fauxToolCall("bash", { command: "echo x > bash-made.txt" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("edit", { path: "a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(writeCall("./a.ts", "export const a = 3;\n"), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					writeCall("sub/b.ts"),
					fauxToolCall("read", { path: "missing.ts" }),
					fauxToolCall("edit", { path: "c.ts", edits: [{ oldText: "x", newText: "y" }] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done: changed a.ts and sub/b.ts."),
		]);
		const result = await runAgent("saved");
		const task = harness.session.tasks.list()[0]!;
		const dir = join(harness.sessionManager.getArtifactDir()!, "agents", task.id);
		expect(harness.sessionManager.getArtifactDir()).toBe(mainFile.replace(/\.jsonl$/u, ""));
		// Edited covers edit/write only, once per file, in first-edit order; the model sees it after the report.
		expect(getMessageText(result)).toBe("Done: changed a.ts and sub/b.ts.\n\nEdited (edit/write): a.ts, sub/b.ts");
		expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("Done: changed a.ts and sub/b.ts.");
		expect(task.outputPath).toBeUndefined();
		expect(taskFact("Tool calls")).toBe("7 · 2 failed");
		expect(taskFact("Edited")).toBe("a.ts, sub/b.ts");
		expect(taskFact("Report")).toBe(join(dir, "report.md"));
		expect(taskFact("Transcript")).toBe(join(dir, "transcript.jsonl"));

		const entries = loadEntriesFromFile(join(dir, "transcript.jsonl"));
		expect(entries[0]).toMatchObject({ type: "session", parentSession: mainFile });
		expect(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
		expect(SessionManager.open(join(dir, "transcript.jsonl")).getEntries().length).toBeGreaterThan(2);

		// The facts live in the saved snapshot, so a continued session still shows them.
		const resumed = await createHarness({ sessionManager: SessionManager.open(mainFile) });
		try {
			const restored = resumed.session.tasks.get(task.id);
			expect(restored.facts).toEqual(task.facts);
			expect(existsSync(taskFact("Report")!)).toBe(true);
		} finally {
			resumed.cleanup();
		}
	});

	it("never lists a nested transcript as a session or continues into it", async () => {
		harness = await createSavedHarness();
		const mainFile = harness.sessionManager.getSessionFile()!;
		harness.setResponses([fauxAssistantMessage("Report")]);
		await runAgent("listing");
		const transcript = taskFact("Transcript")!;
		expect(existsSync(transcript)).toBe(true);
		const sessionDir = harness.sessionManager.getSessionDir();
		const listed = await SessionManager.list(harness.sessionManager.getCwd(), sessionDir);
		expect(listed.map((info) => info.path)).toEqual([mainFile]);
		expect(SessionManager.continueRecent(harness.sessionManager.getCwd(), sessionDir).getSessionFile()).toBe(
			mainFile,
		);
	});

	it("keeps an oversized report where the session can find it, and appends Edited after truncation", async () => {
		harness = await createSavedHarness();
		const report = `START\n${"x".repeat(30 * 1024)}\nEND`;
		harness.setResponses([
			fauxAssistantMessage(writeCall("a.ts"), { stopReason: "toolUse" }),
			fauxAssistantMessage(report),
		]);
		const result = await runAgent("oversized");
		const task = harness.session.tasks.list()[0]!;
		const reportPath = join(harness.sessionManager.getArtifactDir()!, "agents", task.id, "report.md");
		const text = getMessageText(result);
		expect(text).toContain(`[Agent output truncated. Full output: ${reportPath}]`);
		expect(text.endsWith("\n\nEdited (edit/write): a.ts")).toBe(true);
		expect(text.indexOf("Edited (edit/write)")).toBeGreaterThan(text.indexOf("Full output"));
		expect(readFileSync(reportPath, "utf8")).toBe(report);
		expect(task.outputPath).toBe(reportPath);
		expect((await harness.session.tasks.read(task.id, { mode: "tail", bytes: 16 })).text).toContain("END");

		// Tasks retention and runtime shutdown never delete a session's report.
		for (let index = 0; index < 33; index++) {
			harness.setResponses([fauxAssistantMessage(`Small ${index}`)]);
			await runAgent(`filler-${index}`);
		}
		expect(harness.session.tasks.list().some((item) => item.id === task.id)).toBe(false);
		expect(existsSync(reportPath)).toBe(true);
		harness.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(reportPath)).toBe(true);
	}, 60_000);

	it("counts every call and edit beyond the retained activity list, within bounded rows", async () => {
		harness = await createSavedHarness();
		const names = Array.from({ length: 60 }, (_, index) => `file-with-a-rather-long-name-${index}.ts`);
		harness.setResponses([
			fauxAssistantMessage(
				names.map((name) => writeCall(name)),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done"),
		]);
		const result = await runAgent("many");
		expect(taskFact("Tool calls")).toBe("60");
		const fact = taskFact("Edited")!;
		expect(fact.startsWith(`${names[0]}, ${names[1]}`)).toBe(true);
		expect(fact).toMatch(/ \+\d+ more$/u);
		expect(Buffer.byteLength(fact)).toBeLessThanOrEqual(1024);
		const line = getMessageText(result).split("\n\n").at(-1)!;
		expect(line.startsWith("Edited (edit/write): file-with-a-rather-long-name-0.ts")).toBe(true);
		expect(line).toMatch(/ \+\d+ more$/u);
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024);
	});

	it("gives a failed Agent the same facts", async () => {
		harness = await createSavedHarness();
		harness.setResponses([
			fauxAssistantMessage(writeCall("a.ts"), { stopReason: "toolUse" }),
			fauxAssistantMessage("Partial", { stopReason: "error", errorMessage: "Model unavailable" }),
		]);
		const result = await runAgent("failing");
		expect(result.details?.state).toBe("failed");
		expect(getMessageText(result)).toContain("Edited (edit/write): a.ts");
		expect(taskFact("Edited")).toBe("a.ts");
		expect(existsSync(taskFact("Report")!)).toBe(true);
		expect(existsSync(taskFact("Transcript")!)).toBe(true);
	});
});
