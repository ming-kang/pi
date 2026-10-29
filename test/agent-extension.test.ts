import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		expect(result.details?.activities).toMatchObject([{ name: "read", status: "ok" }]);
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
