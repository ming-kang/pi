import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "../src/core/sdk.ts";
import { createExploreTool } from "../src/extensions/explore/index.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
});

describe("Explore investigation", () => {
	it("disposes a session that finishes initialization after cancellation", async () => {
		harness = await createHarness();
		const create = sdk.createAgentSession;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let disposed: ReturnType<typeof vi.fn> | undefined;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options) => {
			const result = await create(options);
			disposed = vi.spyOn(result.session, "dispose");
			await gate;
			return result;
		});
		const parent = new AbortController();
		const running = createExploreTool().execute(
			"initializing",
			{ query: "Investigate" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		await vi.waitFor(() => expect(disposed).toBeDefined());
		parent.abort();
		await expect(running).rejects.toThrow();
		release();
		await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
		expect(harness.faux.state.callCount).toBe(0);
	});
	it("continues through the session's automatic compaction", async () => {
		harness = await createHarness({ models: [{ id: "small", contextWindow: 32000, maxTokens: 4096 }] });
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;\n".repeat(1200));
		let summaries = 0;
		const respond: FauxResponseStep = (context, _options, state) => {
			if (!getCurrentTools(context.messages).length) {
				summaries++;
				return fauxAssistantMessage("SUMMARY_MARKER: entry.ts defines answer as 42.");
			}
			if (JSON.stringify(context.messages).includes("SUMMARY_MARKER"))
				return fauxAssistantMessage("Final answer: entry.ts:1 defines 42.");
			return fauxAssistantMessage(fauxToolCall("read", { path: "entry.ts" }, { id: `read-${state.callCount}` }), {
				stopReason: "toolUse",
			});
		};
		harness.setResponses(Array.from({ length: 16 }, () => respond));
		const result = await createExploreTool().execute(
			"compact",
			{ query: "Investigate entry.ts" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		expect(getMessageText(result)).toContain("Final answer");
		expect(summaries).toBeGreaterThan(0);
	});

	it("cancels a foreground request and preserves its observed partial report", async () => {
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
		const running = createExploreTool().execute(
			"cancel",
			{ query: "Investigate" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
		parent.abort();
		await running;
		const task = harness.session.tasks.list()[0]!;
		expect(task.status).toBe("cancelled");
		expect(getMessageText(task.result)).toContain("Found entry.ts");
	});

	it("does not present interim commentary as a completed report", async () => {
		harness = await createHarness();
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;");
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: "Searching now" }, fauxToolCall("read", { path: "entry.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(""),
		]);
		const result = await createExploreTool().execute(
			"empty",
			{ query: "Investigate" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		expect(getMessageText(result)).toBe("No report returned.");
	});
	it("uses a private read-only conversation for more than twelve responses", async () => {
		harness = await createHarness();
		writeFileSync(join(harness.tempDir, "entry.ts"), "export const answer = 42;");
		const responses = Array.from({ length: 13 }, (_, index) =>
			fauxAssistantMessage(fauxToolCall("read", { path: "entry.ts" }, { id: `read-${index}` }), {
				stopReason: "toolUse",
			}),
		);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
				expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_PARENT_CONVERSATION");
				return responses[0]!;
			},
			...responses.slice(1),
			fauxAssistantMessage("## Answer\n42\n\n## Source evidence\nentry.ts:1"),
		]);
		harness.sessionManager.appendMessage({ role: "user", content: "PRIVATE_PARENT_CONVERSATION", timestamp: 1 });
		const result = await createExploreTool().execute(
			"explore-call",
			{ query: "Find the answer" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		expect(getMessageText(result)).toContain("entry.ts:1");
		expect(harness.faux.state.callCount).toBe(14);
		const task = harness.session.tasks.list()[0]!;
		expect(task.status).toBe("completed");
		expect(task.viewData?.data).toMatchObject({ query: "Find the answer", report: expect.stringContaining("42") });
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "task-usage"),
		).toHaveLength(1);
	});
	it("continues the same investigation after foreground handoff and parent cancellation", async () => {
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
				return fauxAssistantMessage("Final evidence");
			},
		]);
		const parent = new AbortController();
		const running = createExploreTool().execute(
			"handoff",
			{ query: "Investigate" },
			parent.signal,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		const task = harness.session.tasks.list()[0]!;
		expect(harness.session.tasks.detach(task.id)).toBe(true);
		expect(getMessageText(await running)).toContain(task.id);
		parent.abort();
		release();
		expect((await harness.session.tasks.wait(task.id)).status).toBe("completed");
		expect(harness.faux.state.callCount).toBe(1);
		resumeNotifications();
	});
	it("fails an unavailable configured model before accepting background work", async () => {
		harness = await createHarness();
		await harness.session.bindExtensions({ tasksEnabled: true });
		const ctx = harness.session.extensionRunner.createContext();
		await ctx.setExtensionSettings("explore", { model: "missing/model" });
		await expect(
			createExploreTool().execute("invalid", { query: "Investigate", background: true }, undefined, undefined, ctx),
		).rejects.toThrow(/model/i);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
