import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

async function startTask(session: AgentSession, title: string) {
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const outcome = await session.tasks.execute({
		kind: "custom",
		title,
		toolCallId: title,
		background: true,
		run: async (control) => {
			control.accept();
			await finished;
			return { result: { content: [{ type: "text", text: `${title} report` }], details: undefined, usage } };
		},
	});
	if (outcome.kind !== "background") throw new Error("Expected a background handoff");
	return { id: outcome.task.id, finish };
}

describe("background completion delivery across an interrupted queue", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("delivers concurrent completions once after queue clearing and metadata rewrites, retaining next-turn context", async () => {
		let releaseTool!: () => void;
		let toolStarted = false;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "hold",
						label: "hold",
						description: "Hold the current tool batch while background workers finish",
						parameters: Type.Object({}),
						execute: async () => {
							toolStarted = true;
							await toolGate;
							return { content: [{ type: "text", text: "main tool finished" }], details: undefined };
						},
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "custom" && event.message.customType === "task-completion") {
							return { message: { ...event.message, customType: "rewritten-notice", details: undefined } };
						}
					});
				},
			],
		});
		harness.setResponses([
			{
				...fauxAssistantMessage(""),
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "hold-call", name: "hold", arguments: {} }],
			},
			fauxAssistantMessage("main work and second report received"),
			fauxAssistantMessage("first report and retained context received"),
		]);
		const { session, sessionManager } = harness;
		const warning = vi.fn();
		await session.bindExtensions({ tasksEnabled: true, onError: warning });
		const prompting = session.prompt("Run the main task while two workers finish");
		await vi.waitFor(() => expect(toolStarted).toBe(true));
		const first = await startTask(session, "first");
		const second = await startTask(session, "second");
		const queued = () => session.agent.peekQueuedMessages().filter((message) => message.role === "custom");
		const notices = () =>
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "rewritten-notice");
		try {
			first.finish();
			second.finish();
			await vi.waitFor(() => expect(queued()).toHaveLength(1));
			expect(queued()[0]).toMatchObject({ details: { taskId: first.id } });
			expect(notices()).toEqual([]);
			session.clearQueue();
			await vi.waitFor(() =>
				expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "task_delivery" })),
			);
			await vi.waitFor(() => expect(queued()[0]).toMatchObject({ details: { taskId: second.id } }));
			await session.sendCustomMessage(
				{ customType: "aside", content: "retained context", display: false },
				{ deliverAs: "nextTurn" },
			);
			releaseTool();
			await prompting;
			await vi.waitFor(() => expect(notices()).toHaveLength(1));
			expect(session.tasks.pendingNotifications().map((task) => task.id)).toEqual([first.id]);
			expect(
				sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === "aside"),
			).toBe(false);
			session.retryTaskNotifications();
			await vi.waitFor(() => expect(notices()).toHaveLength(2));
			await session.waitForIdle();
			const messages = sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			expect(messages.map((entry) => entry.customType)).toEqual(["rewritten-notice", "rewritten-notice", "aside"]);
			expect(String(messages[0].content)).toContain(second.id);
			expect(String(messages[1].content)).toContain(first.id);
			expect(session.tasks.pendingNotifications()).toEqual([]);
			const ledger = sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === "task-usage" ? [entry.data] : []));
			expect(ledger).toEqual([
				{ version: 1, taskId: first.id, usage },
				{ version: 1, taskId: second.id, usage },
			]);
		} finally {
			first.finish();
			second.finish();
			releaseTool();
			await prompting;
		}
	});
});
