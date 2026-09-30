import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { getKeybindings, setKeybindings, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	TerminalInputHandler,
	ToolDefinition,
	ToolRenderContext,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";
import { runKill, runList, runRead, runWait } from "../src/core/tools/tasks/actions.ts";
import type { tasksSchema } from "../src/core/tools/tasks/schema.ts";
import type { TasksDetails, TasksNotificationDetails } from "../src/core/tools/tasks/types.ts";
import {
	renderLegacyTaskNotification,
	renderTasksCall,
	renderTasksResult,
	scheduleWaitRefresh,
	type TasksRenderState,
} from "../src/modes/interactive/tasks/render.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { createTasksHarness } from "./test-tasks-ui.ts";

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
const services: TaskRuntime[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	vi.useRealTimers();
});
function running(kind: "bash" | "subagent" = "bash") {
	const service = new TaskRuntime({ enabled: true });
	services.push(service);
	let finish!: () => void;
	let control!: TaskControl<undefined>;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const outcome = service.execute({
		kind,
		title: "build",
		toolCallId: "call",
		background: true,
		async run(ctx) {
			control = ctx;
			ctx.accept();
			ctx.publish({ content: [{ type: "text", text: "progress" }], details: undefined });
			await done;
			return { result: { content: [{ type: "text", text: "final report" }], details: undefined } };
		},
	});
	return {
		service,
		outcome,
		finish,
		get control() {
			return control;
		},
	};
}
describe("public Background management", () => {
	it("registers management only, with native presentation", () => {
		let tool: ToolDefinition<typeof tasksSchema, TasksDetails, TasksRenderState> | undefined;
		const pi = {
			on: vi.fn(),
			registerTool: (value: typeof tool) => {
				tool = value;
			},
			registerMessageRenderer: vi.fn(),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		createTasksHarness()(pi);
		expect(tool?.name).toBe("tasks");
		expect(tool?.renderShell).toBeUndefined();
		expect(tool?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(JSON.stringify(tool?.parameters)).not.toContain('"create"');
		expect(JSON.stringify(tool?.parameters)).not.toContain('"command"');
		expect(() => makeStrictJsonSchema(tool!.parameters)).not.toThrow();
	});
	it("lists the session's current tasks when the id is unknown", async () => {
		let tool: ToolDefinition<typeof tasksSchema, TasksDetails, TasksRenderState> | undefined;
		const pi = {
			on: vi.fn(),
			registerTool: (value: typeof tool) => {
				tool = value;
			},
			registerMessageRenderer: vi.fn(),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		createTasksHarness()(pi);
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const ctx = { tasks: h.service } as unknown as ExtensionToolContext;
		const failure = tool!.execute("call", { action: "read", taskId: "nope" }, undefined, undefined, ctx);
		await expect(failure).rejects.toThrow(
			/No background task "nope" in this session\. IDs from other sessions are not valid here\./,
		);
		await expect(failure).rejects.toThrow(new RegExp(`Current tasks:\\n${id} `));
		h.finish();
	});
	it("reads and lists both kinds using the same service", async () => {
		for (const kind of ["bash", "subagent"] as const) {
			const h = running(kind);
			const outcome = await h.outcome;
			expect(outcome.kind).toBe("background");
			const id = h.service.list()[0]!.id;
			expect(textOf(runList(h.service))).toContain(kind);
			expect(textOf(await runRead(h.service, { action: "read", taskId: id }))).toContain("progress");
			h.finish();
			await h.service.wait(id, 1000);
			expect(textOf(await runWait(h.service, { action: "wait", taskId: id }))).toContain("final report");
		}
	});
	it("marks only terminal wait outcomes, never an expired window or a read", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const expired = await runWait(h.service, { action: "wait", taskId: id, waitMs: 0 });
		expect(expired.details.timedOut).toBe(true);
		expect(expired.details).not.toHaveProperty("backgroundTaskId");
		h.finish();
		const finished = await runWait(h.service, { action: "wait", taskId: id });
		expect(finished.details.taskId).toBe(id);
		expect(h.service.pendingNotifications()).toMatchObject([{ id }]);
		expect((await runRead(h.service, { action: "read", taskId: id })).details).not.toHaveProperty("backgroundTaskId");
	});
	it("wait cancellation only cancels the waiter, then final output remains readable", async () => {
		const h = running("subagent");
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const abort = new AbortController();
		const wait = runWait(h.service, { action: "wait", taskId: id }, abort.signal);
		abort.abort();
		await expect(wait).rejects.toThrow();
		expect(h.control.signal.aborted).toBe(false);
		h.finish();
		await h.service.wait(id, 1000);
		expect(textOf(await runRead(h.service, { action: "read", taskId: id }))).toContain("final report");
	});
	it("reports a closed host instead of claiming execution continues", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		h.service.close();
		const text = textOf(await runWait(h.service, { action: "wait", taskId: id, waitMs: 1000 }));
		expect(text).toContain("host closed");
		expect(text).not.toContain("execution continues");
		h.finish();
	});
	it("reports cancellation requested, never falsely stopped, and targets the whole group", async () => {
		const h = running("subagent");
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const result = runKill(h.service, { action: "kill", taskId: id });
		expect(textOf(result)).toContain("Cancellation requested");
		expect(result.details.status).toBe("stopping");
		expect(h.control.signal.aborted).toBe(true);
		h.finish();
	});
	it("says there are no tasks when an unknown id arrives in an empty session", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		await expect(runRead(service, { action: "read", taskId: "nope" })).rejects.toThrow(
			'No background task "nope" in this session. No background tasks in this session.',
		);
		expect(() => runKill(service, { action: "kill", taskId: "nope" })).toThrow(
			'No background task "nope" in this session. No background tasks in this session.',
		);
	});
	it("enriches unknown ids across read, wait, and kill with the same listing", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		await expect(runRead(h.service, { action: "read", taskId: "nope" })).rejects.toThrow(/Current tasks:/);
		await expect(runWait(h.service, { action: "wait", taskId: "nope" })).rejects.toThrow(/Current tasks:/);
		expect(() => runKill(h.service, { action: "kill", taskId: "nope" })).toThrow(
			new RegExp(`No background task "nope" in this session[\\s\\S]*${id}`),
		);
		h.finish();
	});
	it("lists exactly the matching tasks for an ambiguous prefix", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const gate = new Promise<void>(() => {});
		const start = (kind: "bash" | "subagent", title: string) =>
			service.execute({
				kind,
				title,
				toolCallId: title,
				background: true,
				async run(control) {
					control.accept();
					await gate;
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
		await Promise.all([start("bash", "first"), start("bash", "second"), start("subagent", "third")]);
		const ids = service.list().map((task) => task.id);
		const bashIds = ids.filter((id) => id.startsWith("bash"));
		expect(bashIds).toHaveLength(2);
		const failure = runRead(service, { action: "read", taskId: "bash" });
		await expect(failure).rejects.toThrow('Ambiguous background task ID "bash" matches 2 tasks:');
		await expect(failure).rejects.toThrow(new RegExp(bashIds[0]!));
		await expect(failure).rejects.toThrow(new RegExp(bashIds[1]!));
		await expect(failure).rejects.not.toThrow(new RegExp(ids.find((id) => id.startsWith("subagent"))!));
	});
	it("resolves a unique kind-stripped prefix without listing tasks", async () => {
		const h = running("bash");
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const suffix = id.slice("bash".length + 1);
		expect(textOf(await runRead(h.service, { action: "read", taskId: suffix }))).toContain("progress");
		h.finish();
	});
	it("lists the most recent finishes, not the oldest, when an unknown id lookup fails", async () => {
		vi.useFakeTimers();
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const ids: string[] = [];
		for (let index = 0; index < 12; index++) {
			await service.execute({
				kind: "bash",
				format: "log",
				title: `task ${index + 1}`,
				toolCallId: `call-${index + 1}`,
				background: true,
				async run(control) {
					control.accept();
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
			const id = service.list()[index]!.id;
			await service.wait(id, 1000);
			ids.push(id);
			vi.advanceTimersByTime(1000);
		}
		const message = await runRead(service, { action: "read", taskId: "nope" }).then(
			() => {
				throw new Error("expected the lookup to fail");
			},
			(error: unknown) => (error as Error).message,
		);
		expect(message).toContain("Current tasks:");
		// The ten-row window keeps the newest finishes; the two oldest fall out.
		expect(message).not.toContain(ids[0]!);
		expect(message).not.toContain(ids[1]!);
		for (const id of ids.slice(2)) expect(message).toContain(id);
	});
	it("keeps foreground executions out of the unknown-id listing, counted like in tasks list", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		let foregroundId = "";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const foreground = service.execute({
			kind: "bash",
			format: "log",
			title: "inline",
			toolCallId: "inline",
			async run(control) {
				control.accept();
				foregroundId = control.id;
				started();
				await gate;
				return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
			},
		});
		await running;
		await service.execute({
			kind: "bash",
			format: "log",
			title: "backgrounded",
			toolCallId: "backgrounded",
			background: true,
			async run(control) {
				control.accept();
				return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
			},
		});
		const backgroundId = service.list().find((task) => task.mode === "background")!.id;
		const message = await runRead(service, { action: "read", taskId: "nope" }).then(
			() => {
				throw new Error("expected the lookup to fail");
			},
			(error: unknown) => (error as Error).message,
		);
		expect(message).toContain(backgroundId);
		expect(message).not.toContain(foregroundId);
		expect(message).toContain("1 foreground execution omitted");
		release();
		await foreground;
	});
	it("lists exactly the matched tasks for an ambiguous prefix even outside the current branch", async () => {
		const service = new TaskRuntime({ enabled: true, anchor: () => "anchor" });
		services.push(service);
		const gates: Array<() => void> = [];
		const start = (title: string) =>
			service.execute({
				kind: "bash",
				format: "log",
				title,
				toolCallId: title,
				background: true,
				async run(control) {
					control.accept();
					await new Promise<void>((resolve) => gates.push(resolve));
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
		const outcomes = [start("first"), start("second")];
		await Promise.all(outcomes);
		for (const release of gates) release();
		const ids = service.list().map((task) => task.id);
		expect(ids).toHaveLength(2);
		// Settle before leaving the branch: handed-off tasks keep delivery pending,
		// so trim retains them as invisible records instead of expiring them.
		await Promise.all(ids.map((id) => service.wait(id, 1000)));
		await service.cancelOutsideBranch(new Set());
		expect(service.list()).toHaveLength(0);
		const message = await runRead(service, { action: "read", taskId: "bash" }).then(
			() => {
				throw new Error("expected the lookup to fail");
			},
			(error: unknown) => (error as Error).message,
		);
		expect(message).toContain('Ambiguous background task ID "bash" matches 2 tasks:');
		for (const id of ids) expect(message).toContain(id);
	});
	it("shows the most recent finishes in tasks list, folding older ones into the count", async () => {
		vi.useFakeTimers();
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const ids: string[] = [];
		for (let index = 0; index < 7; index++) {
			await service.execute({
				kind: "bash",
				format: "log",
				title: `task ${index + 1}`,
				toolCallId: `call-${index + 1}`,
				background: true,
				async run(control) {
					control.accept();
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
			const id = service.list()[index]!.id;
			await service.wait(id, 1000);
			ids.push(id);
			vi.advanceTimersByTime(1000);
		}
		const text = textOf(runList(service));
		// TASKS_LIST_FINISHED_SHOWN is 5: the two oldest finishes fold into the count.
		expect(text).not.toContain(ids[0]!);
		expect(text).not.toContain(ids[1]!);
		for (const id of ids.slice(2)) expect(text).toContain(id);
		expect(text).toContain("2 more records not shown.");
	});
	it("keeps missing-log and terminal diagnostics ahead of a long fallback, including waits with no delta", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		await service.execute({
			kind: "bash",
			format: "log",
			title: "missing log",
			toolCallId: "missing",
			background: true,
			async run(control) {
				control.setOutputPath(join(process.cwd(), `missing-${randomUUID()}.log`));
				control.accept();
				return {
					status: "failed",
					error: "Command exited with code 42",
					result: { content: [{ type: "text", text: "fallback output\n".repeat(6000) }], details: undefined },
				};
			},
		});
		const id = service.list()[0]!.id;
		await service.wait(id);
		const slice = await service.read(id, { mode: "tail", bytes: 1024 });
		expect(slice.readError).toContain("ENOENT");
		expect(slice.text).toContain("fallback output");
		for (const result of [
			await runRead(service, { action: "read", taskId: id, bytes: 50 * 1024 }),
			await runWait(service, { action: "wait", taskId: id, sinceBytes: slice.totalBytes }),
		]) {
			const text = textOf(result);
			expect(text).toContain("Task error: Command exited with code 42");
			expect(text).toContain("Output read error:");
			expect(text).toContain("ENOENT");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
			if (text.includes("fallback output"))
				expect(text.indexOf("ENOENT")).toBeLessThan(text.indexOf("fallback output"));
		}
	});

	it("bounds list output including oversized titles", async () => {
		const h = running();
		await h.outcome;
		const original = h.service.list()[0]!;
		vi.spyOn(h.service, "list").mockReturnValue(
			Array.from({ length: 150 }, () => ({ ...original, title: "界".repeat(50000) })),
		);
		expect(Buffer.byteLength(textOf(runList(h.service)))).toBeLessThanOrEqual(50 * 1024);
		h.finish();
	});
	it("omits the hidden-records suffix when the list fits", async () => {
		const h = running();
		await h.outcome;
		expect(textOf(runList(h.service))).not.toContain("more records not shown");
		const original = h.service.list()[0]!;
		vi.spyOn(h.service, "list").mockReturnValue(Array.from({ length: 105 }, () => ({ ...original })));
		expect(textOf(runList(h.service))).toContain("5 more records not shown.");
		h.finish();
	});
	it("releases renderer timers when a pending wait row is disposed", () => {
		vi.useFakeTimers();
		const state: TasksRenderState = {};
		const invalidate = vi.fn();
		const ctx = { state, invalidate } as unknown as ToolRenderContext<TasksRenderState>;
		scheduleWaitRefresh(ctx, true);
		expect(vi.getTimerCount()).toBe(1);
		state.dispose?.();
		vi.advanceTimersByTime(2000);
		expect(invalidate).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("closes an open /tasks via done on session shutdown without cancelling execution", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerCommand: (_name: string, value: typeof command) => {
				command = value;
			},
		} as unknown as ExtensionAPI;
		createTasksHarness()(pi);
		const h = running();
		await h.outcome;
		const done = vi.fn();
		let menu: { dispose?(): void } | undefined;
		const ctx = {
			tasks: h.service,
			mode: "tui",
			ui: {
				onTerminalInput: () => () => {},
				setStatus: vi.fn(),
				custom: (factory: Parameters<ExtensionToolContext["ui"]["custom"]>[0]) =>
					new Promise<void>((resolve) => {
						const component = factory(
							{ requestRender: vi.fn(), terminal: { columns: 80, rows: 24 } } as unknown as TUI,
							{
								fg: (_color: string, text: string) => text,
								bg: (_color: string, text: string) => text,
							} as unknown as Theme,
							new KeybindingsManager(),
							() => {
								done();
								menu?.dispose?.();
								resolve();
							},
						);
						void Promise.resolve(component).then((value) => {
							menu = value;
						});
					}),
			},
		} as unknown as ExtensionCommandContext;
		const pending = command!.handler("", ctx);
		await Promise.resolve();
		handlers.get("session_shutdown")?.({}, ctx);
		await pending;
		expect(done).toHaveBeenCalledOnce();
		expect(h.control.signal.aborted).toBe(false);
		h.finish();
	});
	it("subscribes status to the public service and unsubscribes on shutdown", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		createTasksHarness()(pi);
		const h = running();
		await h.outcome;
		const setStatus = vi.fn();
		const ctx = {
			tasks: h.service,
			ui: { setStatus, onTerminalInput: () => () => {} },
		} as unknown as ExtensionToolContext;
		handlers.get("session_start")?.({}, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("background", "tasks 1 active · 0 finished");
		handlers.get("session_shutdown")?.({}, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("background", undefined);
		const calls = setStatus.mock.calls.length;
		h.finish();
		await h.service.wait(h.service.list()[0]!.id, 1000);
		expect(setStatus).toHaveBeenCalledTimes(calls);
	});

	it("moves running foreground executions to the background on the detach key", async () => {
		const previousKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.create());
		try {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
					handlers.set(event, handler),
				registerTool: vi.fn(),
				registerMessageRenderer: vi.fn(),
				registerCommand: vi.fn(),
			} as unknown as ExtensionAPI;
			createTasksHarness()(pi);
			const service = new TaskRuntime({ enabled: true });
			services.push(service);
			let input: TerminalInputHandler | undefined;
			const unsubscribeInput = vi.fn();
			const notify = vi.fn();
			const ui = {
				setStatus: vi.fn(),
				notify,
				onTerminalInput: (handler: TerminalInputHandler) => {
					input = handler;
					return unsubscribeInput;
				},
			};
			handlers.get("session_start")?.({}, { tasks: service, ui } as unknown as ExtensionToolContext);
			const detachKey = "";
			expect(getKeybindings().matches(detachKey, "app.tasks.detach")).toBe(true);

			// Nothing runs yet, so the key falls through to the editor.
			expect(input?.(detachKey)).toBeUndefined();
			let finish!: () => void;
			const done = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const outcome = service.execute({
				kind: "bash",
				format: "log",
				title: "build",
				toolCallId: "foreground",
				background: false,
				async run(ctx) {
					ctx.accept();
					await done;
					return { result: { content: [{ type: "text", text: "built" }], details: undefined } };
				},
			});
			await vi.waitFor(() => expect(service.list()).toHaveLength(1));
			expect(input?.("x")).toBeUndefined();
			expect(input?.(detachKey)).toEqual({ consume: true });
			expect(notify).toHaveBeenCalledWith("Moved 1 execution to the background. Use /tasks to manage tasks.");
			expect((await outcome).kind).toBe("background");
			finish();

			handlers.get("session_shutdown")?.({}, { tasks: service, ui } as unknown as ExtensionToolContext);
			expect(unsubscribeInput).toHaveBeenCalledOnce();
		} finally {
			setKeybindings(previousKeybindings);
		}
	});

	it("advertises the detach key only after ten seconds and only while a foreground execution can move", async () => {
		const previousKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.create());
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
					handlers.set(event, handler),
				registerTool: vi.fn(),
				registerMessageRenderer: vi.fn(),
				registerCommand: vi.fn(),
			} as unknown as ExtensionAPI;
			createTasksHarness()(pi);
			const service = new TaskRuntime({ enabled: true });
			services.push(service);
			let input: TerminalInputHandler | undefined;
			const setStatus = vi.fn();
			const ui = {
				setStatus,
				notify: vi.fn(),
				onTerminalInput: (handler: TerminalInputHandler) => {
					input = handler;
					return () => {};
				},
			};
			const ctx = { tasks: service, ui } as unknown as ExtensionToolContext;
			handlers.get("session_start")?.({}, ctx);
			expect(setStatus).toHaveBeenLastCalledWith("background", undefined);

			const start = (toolCallId: string) => {
				let finish!: () => void;
				const done = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const outcome = service.execute({
					kind: "bash",
					format: "log",
					title: toolCallId,
					toolCallId,
					background: false,
					async run(control) {
						control.accept();
						await done;
						return { result: { content: [{ type: "text", text: "ok" }], details: undefined } };
					},
				});
				return { finish, outcome };
			};
			const hint = "Ctrl+B to background";

			// A command that finishes before the delay never shows the hint, and leaves no timer behind.
			const quick = start("quick");
			await vi.advanceTimersByTimeAsync(9_999);
			expect(setStatus).toHaveBeenLastCalledWith("background", undefined);
			quick.finish();
			await quick.outcome;
			expect(setStatus).toHaveBeenLastCalledWith("background", undefined);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(setStatus).toHaveBeenLastCalledWith("background", undefined);

			// A command still running at ten seconds gets the hint, and moving it clears the hint.
			const long = start("long");
			await vi.advanceTimersByTimeAsync(9_999);
			expect(setStatus).toHaveBeenLastCalledWith("background", undefined);
			await vi.advanceTimersByTimeAsync(1);
			expect(setStatus).toHaveBeenLastCalledWith("background", hint);
			expect(input?.("\x02")).toEqual({ consume: true });
			// Moved work is counted as background work and no longer needs the hint.
			expect(setStatus).toHaveBeenLastCalledWith("background", "tasks 1 active · 0 finished");
			long.finish();
			await long.outcome;

			// A cancelled execution that is still stopping cannot be moved, so the key is not advertised.
			const stubborn = start("stubborn");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(setStatus.mock.lastCall?.[1]).toEqual(expect.stringContaining(hint));
			service.kill(service.list().find((task) => task.toolCallId === "stubborn")!.id);
			expect(setStatus.mock.lastCall?.[1]).not.toContain("Ctrl+B");
			stubborn.finish();
			await stubborn.outcome;

			// Shutting the session down cancels a pending hint.
			const last = start("last");
			await vi.advanceTimersByTimeAsync(5_000);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			handlers.get("session_shutdown")?.({}, ctx);
			expect(vi.getTimerCount()).toBe(0);
			last.finish();
			await last.outcome;
		} finally {
			vi.useRealTimers();
			setKeybindings(previousKeybindings);
		}
	});
});

describe("renderLegacyTaskNotification", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const details: TasksNotificationDetails = {
		taskId: "bg-abc123",
		command: "npm run build",
		status: "completed",
		exitCode: 0,
		runtimeMs: 12_000,
		outputPath: "/tmp/pi-bg-abc123.log",
		totalBytes: 200,
		tailText: "build finished\n",
		tailTruncated: false,
	};

	function message(overrides?: Partial<TasksNotificationDetails>): CustomMessage<TasksNotificationDetails> {
		return {
			role: "custom",
			customType: "background-task",
			content: "",
			display: true,
			details: { ...details, ...overrides },
			timestamp: Date.now(),
		};
	}

	it("renders a collapsed summary and expands with the output tail", () => {
		const collapsed = renderLegacyTaskNotification(message(), { expanded: false, outputPad: 1 }, plainTheme);
		expect(collapsed).toBeDefined();
		const collapsedLines = (collapsed?.render(120) ?? []).map(stripTerminalSequences);
		expect(collapsedLines.join("\n")).toContain("bg-abc123");
		expect(collapsedLines.join("\n")).toContain("completed, exit 0");
		expect(collapsedLines.join("\n")).not.toContain("build finished");
		// Collapsed keeps the row compact: file name only, not the full path.
		expect(collapsedLines.join("\n")).toContain("pi-bg-abc123.log");
		expect(collapsedLines.join("\n")).not.toContain("/tmp/pi-bg-abc123.log");

		const expanded = renderLegacyTaskNotification(message(), { expanded: true, outputPad: 1 }, plainTheme);
		const expandedLines = (expanded?.render(120) ?? []).map(stripTerminalSequences);
		expect(expandedLines.join("\n")).toContain("build finished");
		expect(expandedLines.join("\n")).toContain("/tmp/pi-bg-abc123.log");
	});

	it("bounds a wide-character command by display width, not code-point count", () => {
		// Each CJK code point occupies two terminal columns, so a count-based
		// truncation emits roughly twice the intended width and overflows the row.
		const command = "编译前端资源包".repeat(40);
		const collapsed = renderLegacyTaskNotification(
			message({ command }),
			{ expanded: false, outputPad: 1 },
			plainTheme,
		);
		const summary = ((collapsed?.render(400) ?? []).map(stripTerminalSequences)[0] ?? "").trimEnd();
		// 120 columns for the command, plus the glyph, id, and outcome.
		expect(visibleWidth(summary)).toBeLessThanOrEqual(200);

		// With a description the command gets the tighter 40-column budget, so the
		// row is shorter still, and the description survives.
		const labelled = renderLegacyTaskNotification(
			message({ command, description: "构建" }),
			{ expanded: false, outputPad: 1 },
			plainTheme,
		);
		const labelledSummary = ((labelled?.render(400) ?? []).map(stripTerminalSequences)[0] ?? "").trimEnd();
		expect(labelledSummary).toContain("构建");
		expect(visibleWidth(labelledSummary)).toBeLessThan(visibleWidth(summary));
	});

	it("keeps the end of an oversized tail when expanded", () => {
		const tailText = `HEAD${"x".repeat(4500)}TAIL`;
		const expanded = renderLegacyTaskNotification(
			message({ tailText }),
			{ expanded: true, outputPad: 1 },
			plainTheme,
		);
		const text = (expanded?.render(200) ?? []).map(stripTerminalSequences).join("\n");
		expect(text).toContain("TAIL");
		expect(text).not.toContain("HEAD");
	});

	it("falls back to the default renderer for malformed details", () => {
		expect(
			renderLegacyTaskNotification(
				message({ taskId: undefined as unknown as string }),
				{ expanded: false, outputPad: 1 },
				plainTheme,
			),
		).toBeUndefined();
	});

	it("renders a stalled notification as waiting-for-input with advice on expand", () => {
		const stalled = message({ stalled: true, status: "running", tailText: "Proceed? (y/n)\n" });

		const collapsed = renderLegacyTaskNotification(stalled, { expanded: false, outputPad: 1 }, plainTheme);
		const collapsedText = (collapsed?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("waiting for input");
		expect(collapsedText).not.toContain("(y/n)");

		const expanded = renderLegacyTaskNotification(stalled, { expanded: true, outputPad: 1 }, plainTheme);
		const expandedText = (expanded?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(expandedText).toContain("Proceed? (y/n)");
		expect(expandedText).toContain("kill");
	});
});

describe("renderTasksCall", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("stays renderable while streaming incomplete arguments", () => {
		const empty = renderTasksCall({} as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(empty.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("tasks");

		const partialAction = renderTasksCall({ action: "cre" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(partialAction.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("tasks cre");

		const createWithoutCommand = renderTasksCall({ action: "create" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(createWithoutCommand.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("tasks create");
	});

	it("shows the full multi-line create command only when expanded", () => {
		const args = { action: "create" as const, command: "echo one\necho two\necho three" };

		const collapsed = renderTasksCall(args, plainTheme, { expanded: false } as ToolRenderContext);
		const collapsedText = collapsed.render(200).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("+2 lines");
		expect(collapsedText).not.toContain("echo three");

		const expanded = renderTasksCall(args, plainTheme, { expanded: true } as ToolRenderContext);
		const expandedText = expanded.render(200).map(stripTerminalSequences).join("\n");
		expect(expandedText).toContain("echo two");
		expect(expandedText).toContain("echo three");
		expect(expandedText).not.toContain("+2 lines");
	});

	it("renders one line per action with the task id and parameters", () => {
		const cases: [
			{
				action: "read" | "wait" | "kill" | "list";
				taskId?: string;
				mode?: "head" | "tail";
				bytes?: number;
				waitMs?: number;
			},
			RegExp,
		][] = [
			[{ action: "read", taskId: "bg-3f", mode: "tail", bytes: 8192 }, /^tasks read bg-3f tail/],
			[{ action: "wait", taskId: "3f", waitMs: 20_000 }, /^tasks wait 3f 20s/],
			[{ action: "kill", taskId: "bg-3f" }, /^tasks kill bg-3f/],
			[{ action: "list" }, /^tasks list/],
		];
		for (const [args, pattern] of cases) {
			const component = renderTasksCall(args as never, plainTheme, { expanded: false } as ToolRenderContext);
			const text = component.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(pattern);
		}
	});

	it("appends the description label to a create call", () => {
		const component = renderTasksCall(
			{ action: "create", command: "npm run dev", description: "dev server" },
			plainTheme,
			{ expanded: false } as ToolRenderContext,
		);
		const text = component.render(200).map(stripTerminalSequences).join("\n");
		expect(text).toContain("npm run dev & · dev server");
	});
});

describe("renderTasksCall wait pending line", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("shows elapsed/window while pending, then settles", () => {
		vi.useFakeTimers();
		try {
			const state: TasksRenderState = {};
			const context = {
				expanded: false,
				executionStarted: true,
				isPartial: true,
				state,
				invalidate: vi.fn(),
			} as unknown as ToolRenderContext<TasksRenderState>;

			const first = renderTasksCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context);
			expect(first.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^tasks wait bg-3f waiting 0s\/20s/);
			expect(state.refreshTimer).toBeDefined();

			// The armed timer invalidates and the next render shows elapsed progress.
			vi.advanceTimersByTime(1000);
			expect(context.invalidate).toHaveBeenCalledTimes(1);
			const second = renderTasksCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context);
			expect(second.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^tasks wait bg-3f waiting 1s\/20s/);

			// Settled: timer cleared, static form returns.
			const settledContext = {
				expanded: false,
				executionStarted: true,
				isPartial: false,
				state,
			} as unknown as ToolRenderContext<TasksRenderState>;
			const settled = renderTasksCall(
				{ action: "wait", taskId: "bg-3f", waitMs: 20_000 },
				plainTheme,
				settledContext,
			);
			expect(settled.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^tasks wait bg-3f 20s/);
			expect(state.refreshTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays static until execution starts", () => {
		const state: TasksRenderState = {};
		// Arguments are still streaming, or this is a replayed transcript row that
		// will never settle. Either way there is nothing to count up to yet.
		const context = {
			expanded: false,
			executionStarted: false,
			isPartial: true,
			state,
		} as unknown as ToolRenderContext<TasksRenderState>;

		const line = renderTasksCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context);
		expect(line.render(200).map(stripTerminalSequences).join("\n")).not.toContain("waiting");
		expect(state.refreshTimer).toBeUndefined();
	});

	it("falls back to the static line without shell state", () => {
		const component = renderTasksCall({ action: "wait", taskId: "bg-3f", waitMs: 5000 }, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext<TasksRenderState>);
		expect(component.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^tasks wait bg-3f 5s/);
	});
});

describe("renderTasksResult summaries", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("carries the description label on a create summary", () => {
		const component = renderTasksResult(
			{
				content: [{ type: "text", text: "Started background task bg-3f." }],
				details: {
					action: "create",
					taskId: "bg-3f",
					outputPath: "/tmp/pi-bg-3f.log",
					command: "npm run dev",
					description: "dev server",
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			{ args: { action: "create" }, state: {} } as ToolRenderContext,
		);
		const text = component.render(200).map(stripTerminalSequences).join("\n");
		expect(text).toContain("bg-3f (dev server) started");
	});
});
