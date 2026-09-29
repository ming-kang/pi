import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskSession } from "../src/core/tasks/session.ts";

describe("task result persistence receipts", () => {
	it("acknowledges an explicitly bound wait after persistence, independent of rewritten details", async () => {
		const host = new TaskSession({
			manager: SessionManager.inMemory(process.cwd()),
			role: "main",
			canDeliver: () => false,
			deliver: async () => {},
			onEntry: () => {},
			onError: () => {},
		});
		host.setEnabled(true);
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const submitted = await host.service.execute({
			kind: "custom",
			title: "report",
			toolCallId: "start",
			background: true,
			run: async (control) => {
				control.accept();
				await gate;
				return { result: { content: [{ type: "text", text: "report" }], details: undefined } };
			},
		});
		if (submitted.kind !== "background") throw new Error("Expected handoff");
		finish();
		await host.service.wait(submitted.task.id);
		const message = {
			role: "toolResult" as const,
			toolCallId: "wait",
			toolName: "tasks",
			content: [],
			details: { backgroundTaskId: submitted.task.id },
			isError: false,
			timestamp: Date.now(),
		};
		host.delivery.messagePersisted(message);
		expect(host.service.pendingNotifications()).toHaveLength(1);
		host.delivery.prepareWait("wait", submitted.task.id);
		expect(host.service.pendingNotifications()).toHaveLength(0);
		host.delivery.messagePersisted({ ...message, details: undefined });
		expect(host.service.pendingNotifications()).toHaveLength(0);
		host.dispose();
	});
});
