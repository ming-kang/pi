import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/core/sdk.ts";
import { createAgentTool } from "../src/extensions/agent/index.ts";
import { AgentGate } from "../src/extensions/agent/runner.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
});

describe("Agent delegation", () => {
	it("uses an isolated coding session and returns activity, report, usage and Tasks details", async () => {
		harness = await createHarness({ settings: { compaction: { enabled: false } } });
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;\n");
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
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
		expect(result.details?.activities).toMatchObject([{ name: "read", target: "entry.ts", status: "ok" }]);
		const task = harness.session.tasks.list()[0]!;
		expect(task).toMatchObject({ kind: "agent", title: "Inspect entry", status: "completed" });
		expect(task.info?.text).toContain("Inspect entry.ts and report the export");
		expect(task.info?.text).toContain(`${harness.models[0]!.provider}/${harness.models[0]!.id}`);
		expect((await harness.session.tasks.read(task.id)).text).toContain("## Report");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "task-usage"),
		).toHaveLength(1);
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
			expect(result.details?.status).toBe("cancelled");
			expect(harness.session.tasks.list()[0]?.status).toBe("cancelled");
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
		expect(result.details?.status).toBe("cancelled");
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
		expect(result.details?.status).toBe("cancelled");
		const task = harness.session.tasks.list()[0]!;
		expect(task.status).toBe("cancelled");
		expect(getMessageText(task.result)).toContain("Found entry.ts");
	});

	it("continues the same Agent after foreground handoff and parent cancellation", async () => {
		harness = await createHarness();
		await harness.session.bindExtensions({ tasksEnabled: true });
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
		expect(handoff.details?.status).toBe("background");
		expect(getMessageText(handoff)).toContain(task.id);
		parent.abort();
		release();
		expect((await harness.session.tasks.wait(task.id)).status).toBe("completed");
		expect(harness.faux.state.callCount).toBe(1);
		resumeNotifications();
	});

	it("keeps parallel calls independent and exposes gate waiting as queued Tasks", async () => {
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
		const tool = createAgentTool(new AgentGate(1));
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

	it("fails an unavailable configured model before accepting background work", async () => {
		harness = await createHarness();
		await harness.session.bindExtensions({ tasksEnabled: true });
		const ctx = harness.session.extensionRunner.createToolContext("invalid", undefined);
		await ctx.setExtensionSettings("agent", { model: "missing/model" });
		await expect(
			createAgentTool().execute("invalid", { prompt: "Investigate", background: true }, undefined, undefined, ctx),
		).rejects.toThrow(/model/i);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.tasks.list()).toEqual([]);
	});
});

describe("AgentGate", () => {
	it("bounds concurrent workers and releases aborted waiters", async () => {
		const gate = new AgentGate(1);
		const first = new AbortController();
		const releaseFirst = await gate.acquire(first.signal);
		const second = new AbortController();
		let entered = false;
		const waiting = gate.acquire(second.signal).then((release) => {
			entered = true;
			release();
		});
		await Promise.resolve();
		expect(entered).toBe(false);
		second.abort();
		await expect(waiting).rejects.toThrow();
		const third = new AbortController();
		const next = gate.acquire(third.signal);
		releaseFirst();
		const releaseThird = await next;
		releaseThird();
	});
});
