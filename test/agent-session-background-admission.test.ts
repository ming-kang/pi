import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { TaskControl } from "../src/core/tasks/types.ts";
import { backgroundSessionTest } from "./background-session-host.ts";
import { sessionDelivery } from "./tasks-delivery-harness.ts";
import { settleTask } from "./tasks-settle.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("session background admission, acknowledgement and tree navigation", () => {
	const { host, task } = backgroundSessionTest();

	it("lets a direct SDK waiter acknowledge a completion so it is never delivered to the model", async () => {
		const session = await host(true, undefined, [fauxAssistantMessage("noticed")]);
		await session.bindExtensions({ tasksEnabled: true });
		const resume = session.pauseTaskNotifications();
		const acknowledged = await task(session);
		const unacknowledged = await task(session);
		acknowledged.finish();
		unacknowledged.finish();
		for (const { id } of [acknowledged, unacknowledged]) {
			expect((await settleTask(session.tasks, id)).outcome).toBe("settled");
		}
		// Observing alone does not acknowledge delivery.
		expect(sessionDelivery(session).pending()).toHaveLength(2);
		session.acknowledgeTaskDelivery(acknowledged.id);
		session.acknowledgeTaskDelivery(acknowledged.id);
		resume();
		await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
		await session.waitForIdle();
		const notices = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		expect(notices).toHaveLength(1);
		expect(JSON.stringify(notices[0])).toContain(unacknowledged.id);
		expect(JSON.stringify(notices[0])).not.toContain(acknowledged.id);
		expect(sessionDelivery(session).pending()).toEqual([]);
	});

	describe("background admission requires the tasks management tool", () => {
		const idle = (control: TaskControl<undefined>) => {
			control.accept();
			return new Promise<never>(() => {});
		};

		it("rejects submissions and every detach path while the tool is inactive, and admits them once it is active", async () => {
			const session = await host();
			await session.bindExtensions({ tasksEnabled: true });
			const tools = session.getActiveToolNames();
			expect(tools).toContain("tasks");
			session.setActiveToolsByName(tools.filter((name) => name !== "tasks"));

			const foreground = session.tasks.execute<undefined>({
				kind: "custom",
				title: "inline",
				toolCallId: "inline",
				run: idle,
			});
			const id = session.tasks.list()[0]!.id;
			await expect(
				session.tasks.execute({ kind: "custom", title: "bg", toolCallId: "bg", background: true, run: idle }),
			).rejects.toThrow(/tasks tool.*No work was started/s);
			expect(session.tasks.list()).toHaveLength(1);
			expect(session.tasks.canDetach(id)).toBe(false);
			expect(session.tasks.detach(id)).toBe(false);
			expect(session.tasks.detachForeground()).toBe(0);
			expect(session.tasks.get(id).mode).toBe("foreground");

			session.setActiveToolsByName(tools);
			expect(session.tasks.canDetach(id)).toBe(true);
			expect(session.tasks.detachForeground()).toBe(1);
			expect(await foreground).toMatchObject({ kind: "background", reason: "detached" });
			const submitted = await session.tasks.execute({
				kind: "custom",
				title: "bg",
				toolCallId: "bg",
				background: true,
				run: idle,
			});
			expect(submitted.kind).toBe("background");
		});

		it("lets work admitted earlier keep running and be delivered after the tool is deactivated", async () => {
			const session = await host(true, undefined, [fauxAssistantMessage("noticed")]);
			await session.bindExtensions({ tasksEnabled: true });
			const resume = session.pauseTaskNotifications();
			const execution = await task(session);
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "tasks"));
			execution.finish();
			await vi.waitFor(() => expect(session.tasks.get(execution.id).status).toBe("completed"));
			resume();
			await vi.waitFor(() => expect(session.messages.some((message) => message.role === "custom")).toBe(true));
			await session.waitForIdle();
			expect(sessionDelivery(session).pending()).toEqual([]);
		});
	});

	it.each([
		["a user message", "u1", ["u1"]],
		["a custom message", "c0", ["c0", "a1", "u1"]],
		["another entry", "a1", ["u1"]],
	] as const)(
		"stoppedByTreeNavigation predicts exactly the tasks that navigating to %s cancels",
		async (_name, target, outside) => {
			const session = await host();
			await session.bindExtensions({ tasksEnabled: true });
			session.pauseTaskNotifications();
			const manager = session.sessionManager;
			const entries = new Map<string, string>();
			const tasks = new Map<string, string>();
			// One task per entry, launched while that entry is the leaf and cancellable.
			const launch = async (name: string, id: string) => {
				entries.set(name, id);
				const outcome = await session.tasks.execute({
					kind: "custom",
					title: name,
					toolCallId: name,
					background: true,
					run: async (control) => {
						control.accept();
						await new Promise<void>((resolve) =>
							control.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return { result: { content: [], details: undefined } };
					},
				});
				if (outcome.kind !== "background") throw new Error("expected handoff");
				tasks.set(name, outcome.task.id);
			};
			await launch("u0", manager.appendMessage(userMsg("u0")));
			await launch("a0", manager.appendMessage(assistantMsg("a0")));
			await launch("c0", manager.appendCustomMessageEntry("note", "custom", true));
			await launch("a1", manager.appendMessage(assistantMsg("a1")));
			await launch("u1", manager.appendMessage(userMsg("u1")));
			// The leaf must be elsewhere, or navigating to it is a no-op.
			manager.appendMessage(assistantMsg("a2"));

			const predicted = session.tasks
				.session!.stoppedByTreeNavigation(entries.get(target)!)
				.map((task) => task.id)
				.sort();
			expect(predicted).toEqual(outside.map((name) => tasks.get(name)!).sort());
			await session.navigateTree(entries.get(target)!);
			const cancelled = [...tasks.values()].filter((id) => session.tasks.get(id).status === "cancelled").sort();
			expect(cancelled).toEqual(predicted);
		},
	);
});
