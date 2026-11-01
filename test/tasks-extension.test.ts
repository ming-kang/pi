import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { getKeybindings, setKeybindings, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";
import { runKill, runList, runRead } from "../src/extensions/tasks/tool/actions.ts";
import type { tasksSchema } from "../src/extensions/tasks/tool/schema.ts";
import type { TasksDetails } from "../src/extensions/tasks/tool/types.ts";
import { renderTasksCall, renderTasksResult } from "../src/extensions/tasks/ui/render.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { createDeliveryHarness } from "./tasks-delivery-harness.ts";
import { settleTask } from "./tasks-settle.ts";
import { createTasksHarness } from "./test-tasks-ui.ts";

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
const services: TaskRuntime[] = [];
function recordStatus() {
	const updates = vi.fn();
	return {
		updates,
		setStatus: (key: string, text: string | undefined) =>
			updates(key, text === undefined ? undefined : stripTerminalSequences(text)),
	};
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	vi.useRealTimers();
});
function running(kind: "bash" | "custom" = "bash", options: Parameters<typeof createDeliveryHarness>[0] = {}) {
	const { runtime: service, pending, delivery } = createDeliveryHarness({ enabled: true, ...options });
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
			ctx.publish({ result: { content: [{ type: "text", text: "progress" }], details: undefined } });
			await done;
			return { result: { content: [{ type: "text", text: "final report" }], details: undefined } };
		},
	});
	return {
		service,
		pending,
		delivery,
		outcome,
		finish,
		get control() {
			return control;
		},
	};
}
describe("public Background management", () => {
	beforeEach(() => initTheme("dark"));
	it("registers management only, with native presentation", () => {
		let tool: ToolDefinition<typeof tasksSchema, TasksDetails> | undefined;
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
		let tool: ToolDefinition<typeof tasksSchema, TasksDetails> | undefined;
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
			/No task "nope" in this session\. IDs from other sessions are not valid here\./,
		);
		await expect(failure).rejects.toThrow(new RegExp(`Current background tasks:\\n${id} `));
		h.finish();
	});
	it("reads and lists both kinds using the same service", async () => {
		for (const kind of ["bash", "custom"] as const) {
			const h = running(kind);
			const outcome = await h.outcome;
			expect(outcome.kind).toBe("background");
			const id = h.service.list()[0]!.id;
			expect(textOf(runList(h.service))).toContain(kind);
			expect(textOf(await runRead(h.service, { action: "read", taskId: id }))).toContain("progress");
			h.finish();
			await settleTask(h.service, id);
			expect(textOf(await runRead(h.service, { action: "read", taskId: id }))).toContain("final report");
		}
	});
	it("leaves a settled task pending after a read until it is acknowledged", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		h.finish();
		await settleTask(h.service, id);
		expect(h.pending()).toMatchObject([{ id }]);
		await runRead(h.service, { action: "read", taskId: id });
		expect(h.pending()).toMatchObject([{ id }]);
		h.delivery.acknowledge(id);
		expect(h.pending()).toEqual([]);
	});
	it("reports cancellation requested, never falsely stopped, and targets the whole group", async () => {
		const h = running("custom");
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
			'No task "nope" in this session. No background tasks in this session.',
		);
		expect(() => runKill(service, { action: "kill", taskId: "nope" })).toThrow(
			'No task "nope" in this session. No background tasks in this session.',
		);
	});
	it("enriches unknown ids across read and kill with the same listing", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		await expect(runRead(h.service, { action: "read", taskId: "nope" })).rejects.toThrow(/Current background tasks:/);
		expect(() => runKill(h.service, { action: "kill", taskId: "nope" })).toThrow(
			new RegExp(`No task "nope" in this session[\\s\\S]*${id}`),
		);
		h.finish();
	});
	it("lists exactly the matching tasks for an ambiguous prefix", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const gate = new Promise<void>(() => {});
		const start = (kind: "bash" | "custom", title: string) =>
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
		await Promise.all([start("bash", "first"), start("bash", "second"), start("custom", "third")]);
		const ids = service.list().map((task) => task.id);
		const bashIds = ids.filter((id) => id.startsWith("bash"));
		expect(bashIds).toHaveLength(2);
		const failure = runRead(service, { action: "read", taskId: "bash" });
		await expect(failure).rejects.toThrow('Ambiguous task ID "bash" matches 2 tasks:');
		await expect(failure).rejects.toThrow(new RegExp(bashIds[0]!));
		await expect(failure).rejects.toThrow(new RegExp(bashIds[1]!));
		await expect(failure).rejects.not.toThrow(new RegExp(ids.find((id) => id.startsWith("custom"))!));
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
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			await service.execute({
				kind: "bash",
				title: `task ${index + 1}`,
				toolCallId: `call-${index + 1}`,
				background: true,
				async run(control) {
					control.accept();
					await gate;
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
			release();
			const id = service.list()[index]!.id;
			await settleTask(service, id);
			ids.push(id);
			vi.advanceTimersByTime(1000);
		}
		const message = await runRead(service, { action: "read", taskId: "nope" }).then(
			() => {
				throw new Error("expected the lookup to fail");
			},
			(error: unknown) => (error as Error).message,
		);
		expect(message).toContain("Current background tasks:");
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
			title: "backgrounded",
			toolCallId: "backgrounded",
			background: true,
			async run(control) {
				control.accept();
				await gate;
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
		const { runtime: service } = createDeliveryHarness({ anchor: () => "anchor" });
		services.push(service);
		const gates: Array<() => void> = [];
		const start = (title: string) =>
			service.execute({
				kind: "bash",
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
		// Settle before leaving the branch: undelivered completions stay leased,
		// so trim retains them as invisible records instead of expiring them.
		await Promise.all(ids.map((id) => settleTask(service, id)));
		await service.cancelOutsideBranch(new Set());
		expect(service.list()).toHaveLength(0);
		const message = await runRead(service, { action: "read", taskId: "bash" }).then(
			() => {
				throw new Error("expected the lookup to fail");
			},
			(error: unknown) => (error as Error).message,
		);
		expect(message).toContain('Ambiguous task ID "bash" matches 2 tasks:');
		for (const id of ids) expect(message).toContain(id);
	});
	it("shows the most recent finishes in tasks list, folding older ones into the count", async () => {
		vi.useFakeTimers();
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const ids: string[] = [];
		for (let index = 0; index < 7; index++) {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			await service.execute({
				kind: "bash",
				title: `task ${index + 1}`,
				toolCallId: `call-${index + 1}`,
				background: true,
				async run(control) {
					control.accept();
					await gate;
					return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
				},
			});
			release();
			const id = service.list()[index]!.id;
			await settleTask(service, id);
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
	it("keeps missing-log and terminal diagnostics ahead of a long fallback", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		await service.execute({
			kind: "bash",
			title: "missing log",
			toolCallId: "missing",
			background: true,
			async run(control) {
				control.attachOutput(join(process.cwd(), `missing-${randomUUID()}.log`));
				control.accept();
				return {
					status: "failed",
					error: "Command exited with code 42",
					result: { content: [{ type: "text", text: "fallback output\n".repeat(6000) }], details: undefined },
				};
			},
		});
		const id = service.list()[0]!.id;
		await settleTask(service, id);
		const slice = await service.read(id, { mode: "tail", bytes: 1024 });
		expect(slice.readError).toContain("ENOENT");
		expect(slice.text).toContain("fallback output");
		const text = textOf(await runRead(service, { action: "read", taskId: id, bytes: 50 * 1024 }));
		expect(text).toContain("Task error: Command exited with code 42");
		expect(text).toContain("Output read error:");
		expect(text).toContain("ENOENT");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
		if (text.includes("fallback output"))
			expect(text.indexOf("ENOENT")).toBeLessThan(text.indexOf("fallback output"));
	});

	it("tells the model which byte range it received and where to continue", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-tasks-offsets-"));
		const path = join(directory, "output.log");
		const line = "build output line\n";
		await writeFile(path, line.repeat(6000));
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		await service.execute({
			kind: "bash",
			title: "build",
			toolCallId: "offsets",
			background: true,
			async run(control) {
				control.attachOutput(path);
				control.accept();
				await done;
				return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
			},
		});
		const id = service.list()[0]!.id;
		const total = Buffer.byteLength(line) * 6000;
		try {
			const read = textOf(await runRead(service, { action: "read", taskId: id }));
			expect(read).toContain(`bytes ${total - 8192}–${total} of ${total}`);
			expect(read).toContain(`next sinceBytes ${total}`);
			const head = textOf(
				await runRead(service, { action: "read", taskId: id, mode: "head", sinceBytes: 1000, bytes: 1000 }),
			);
			expect(head).toContain(`bytes 1000–2000 of ${total}`);
			expect(head).toContain("next sinceBytes 2000");
			const tail = textOf(await runRead(service, { action: "read", taskId: id, sinceBytes: 0, bytes: 8192 }));
			expect(tail).toContain(`skipped ${total - 8192} bytes after sinceBytes 0`);
		} finally {
			finish();
			await settleTask(service, id);
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("reads a report from its start and a log from its end unless the mode says otherwise", async () => {
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		const document = `START\n${"m".repeat(40 * 1024)}\nEND`;
		const settle = async (output: "log" | "report") => {
			await service.execute({
				kind: "custom",
				title: output,
				output,
				toolCallId: output,
				background: true,
				async run(control) {
					control.accept();
					return { result: { content: [{ type: "text", text: document }], details: undefined } };
				},
			});
			const id = service.list().find((task) => task.title === output)!.id;
			await settleTask(service, id);
			return id;
		};
		const report = await settle("report");
		const log = await settle("log");

		const fromStart = await runRead(service, { action: "read", taskId: report, bytes: 1000 });
		expect(fromStart.details.mode).toBe("head");
		expect(textOf(fromStart)).toContain(" · bytes 0–1000 of ");
		expect(textOf(fromStart)).toContain("START");
		expect(textOf(fromStart)).not.toContain("END");

		const fromEnd = await runRead(service, { action: "read", taskId: log, bytes: 1000 });
		expect(fromEnd.details.mode).toBe("tail");
		expect(textOf(fromEnd)).toContain("END");
		expect(textOf(fromEnd)).not.toContain("START");

		const forced = await runRead(service, { action: "read", taskId: report, mode: "tail", bytes: 1000 });
		expect(forced.details.mode).toBe("tail");
		expect(textOf(forced)).toContain("END");
		expect(textOf(forced)).not.toContain("START");
	});
	it("continues reports by raw source bytes when a file is not valid UTF-8", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-tasks-binary-offsets-"));
		const path = join(directory, "report.bin");
		const source = Buffer.concat([
			Buffer.from("START\n"),
			Buffer.from([0x80, 0x81, 0xfe]),
			Buffer.from("x".repeat(430)),
		]);
		const window = 256;
		await writeFile(path, source);
		const service = new TaskRuntime({ enabled: true });
		services.push(service);
		try {
			await service.execute({
				kind: "custom",
				title: "binary report",
				output: "report",
				toolCallId: "binary-report",
				async run(control) {
					control.attachOutput(path);
					control.accept();
					return { result: { content: [{ type: "text", text: "stored report" }], details: undefined } };
				},
			});
			const id = service.list()[0]!.id;
			await settleTask(service, id);
			const first = await runRead(service, { action: "read", taskId: id, bytes: window });
			expect(first.details).toMatchObject({ sliceBytes: window, totalBytes: source.length });
			expect(textOf(first)).toContain(` · bytes 0–${window} of ${source.length} · next sinceBytes ${window}`);
			const offset = Number(/next sinceBytes (\d+)/.exec(textOf(first))?.[1]);
			expect(offset).toBe(window);

			const next = await service.read(id, { mode: "head", sinceBytes: offset, bytes: window });
			expect(next).toMatchObject({ fromByte: window, totalBytes: source.length });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("clamps read size to the retained slice limit", async () => {
		const h = running();
		await h.outcome;
		const id = h.service.list()[0]!.id;
		const read = vi.spyOn(h.service, "read");
		await runRead(h.service, { action: "read", taskId: id, bytes: 50 * 1024 });
		expect(read).toHaveBeenCalledWith(id, expect.objectContaining({ bytes: 48 * 1024 }));
		h.finish();
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
		const { setStatus, updates } = recordStatus();
		const ctx = {
			tasks: h.service,
			ui: { setStatus, onTerminalInput: () => () => {} },
		} as unknown as ExtensionToolContext;
		handlers.get("session_start")?.({}, ctx);
		expect(updates).toHaveBeenLastCalledWith("background", "1 background task · /tasks to view");
		handlers.get("session_shutdown")?.({}, ctx);
		expect(updates).toHaveBeenLastCalledWith("background", undefined);
		const calls = updates.mock.calls.length;
		h.finish();
		await settleTask(h.service, h.service.list()[0]!.id);
		expect(updates).toHaveBeenCalledTimes(calls);
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
			const { setStatus, updates } = recordStatus();
			const ui = {
				setStatus,
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
			// A short foreground command leaves the statusline empty.
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			expect(input?.(detachKey)).toEqual({ consume: true });
			expect(notify).toHaveBeenCalledWith("Moved 1 execution to the background. Use /tasks to manage tasks.");
			expect((await outcome).kind).toBe("background");
			// Detaching makes the background summary appear.
			expect(updates).toHaveBeenLastCalledWith("background", "1 background task · /tasks to view");
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
			const service = new TaskRuntime({ enabled: true, maxBackground: 2 });
			services.push(service);
			let input: TerminalInputHandler | undefined;
			const { setStatus, updates } = recordStatus();
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
			expect(updates).toHaveBeenLastCalledWith("background", undefined);

			const start = (toolCallId: string) => {
				let finish!: () => void;
				const done = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const outcome = service.execute({
					kind: "bash",
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
			const hint = "Ctrl+B to run in background";

			// A command that finishes before the delay never shows the hint, and leaves no timer behind.
			const quick = start("quick");
			await vi.advanceTimersByTimeAsync(9_999);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			quick.finish();
			await quick.outcome;
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);

			// A command still running at ten seconds gets the hint, and moving it clears the hint.
			const long = start("long");
			await vi.advanceTimersByTimeAsync(9_999);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			await vi.advanceTimersByTimeAsync(1);
			expect(updates).toHaveBeenLastCalledWith("background", hint);
			expect(input?.("\x02")).toEqual({ consume: true });
			// Moved work is counted as background work and no longer needs the hint.
			expect(updates).toHaveBeenLastCalledWith("background", "1 background task · /tasks to view");

			// The full background hides the hint, then freeing a slot reveals it without a new delay.
			const mixed = start("mixed");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(updates).toHaveBeenLastCalledWith("background", `1 background task · /tasks to view · ${hint}`);
			expect(input?.("\x02")).toEqual({ consume: true });
			expect(updates).toHaveBeenLastCalledWith("background", "2 background tasks · /tasks to view");
			const blocked = start("blocked");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(updates).toHaveBeenLastCalledWith("background", "2 background tasks · /tasks to view");
			expect(vi.getTimerCount()).toBe(0);
			mixed.finish();
			await mixed.outcome;
			await settleTask(service, service.list().find((task) => task.toolCallId === "mixed")!.id);
			expect(updates).toHaveBeenLastCalledWith("background", `1 background task · /tasks to view · ${hint}`);
			long.finish();
			await long.outcome;
			await settleTask(service, service.list().find((task) => task.toolCallId === "long")!.id);
			expect(updates).toHaveBeenLastCalledWith("background", hint);
			service.setEnabled(false);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			service.setEnabled(true);
			expect(updates).toHaveBeenLastCalledWith("background", hint);
			setKeybindings(new KeybindingsManager({ "app.tasks.detach": "ctrl+y" }));
			service.setEnabled(true);
			expect(updates).toHaveBeenLastCalledWith("background", "Ctrl+Y to run in background");
			setKeybindings(new KeybindingsManager({ "app.tasks.detach": [] }));
			service.setEnabled(true);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			setKeybindings(KeybindingsManager.create());
			blocked.finish();
			await blocked.outcome;

			// A cancelled execution that is still stopping cannot be moved, so the key is not advertised.
			const stubborn = start("stubborn");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(updates.mock.lastCall?.[1]).toEqual(expect.stringContaining(hint));
			service.kill(service.list().find((task) => task.toolCallId === "stubborn")!.id);
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
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

	it("counts only active background tasks and hides retained results", async () => {
		const previousKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.create());
		try {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => void>();
			const pi = {
				on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => void) =>
					handlers.set(event, handler),
				registerTool: vi.fn(),
				registerMessageRenderer: vi.fn(),
				registerCommand: vi.fn(),
			} as unknown as ExtensionAPI;
			createTasksHarness()(pi);
			const service = new TaskRuntime({ enabled: true });
			services.push(service);
			const { setStatus, updates } = recordStatus();
			const ui = {
				setStatus,
				notify: vi.fn(),
				onTerminalInput: () => () => {},
			};
			const ctx = { tasks: service, ui } as unknown as ExtensionToolContext;
			handlers.get("session_start")?.({}, ctx);
			const execute = (toolCallId: string, background: boolean) => {
				let finish!: () => void;
				const open = new Promise<void>((resolve) => {
					finish = resolve;
				});
				const outcome = service.execute({
					kind: "bash",
					title: toolCallId,
					toolCallId,
					background,
					async run(control) {
						control.accept();
						await open;
						return { result: { content: [{ type: "text", text: "ok" }], details: undefined } };
					},
				});
				return { finish, outcome };
			};
			const background = execute("background", true);
			await vi.waitFor(() => expect(updates.mock.lastCall?.[1]).toBe("1 background task · /tasks to view"));
			const foreground = execute("foreground", false);
			await vi.waitFor(() => expect(updates.mock.lastCall?.[1]).toBe("1 background task · /tasks to view"));
			const second = execute("second", true);
			await second.outcome;
			expect(updates).toHaveBeenLastCalledWith("background", "2 background tasks · /tasks to view");
			const secondId = service.list().find((task) => task.toolCallId === "second")!.id;
			service.kill(secondId);
			expect(updates).toHaveBeenLastCalledWith("background", "2 background tasks · /tasks to view");
			second.finish();
			await settleTask(service, secondId);
			expect(updates).toHaveBeenLastCalledWith("background", "1 background task · /tasks to view");
			// Finished records remain available without keeping the statusline visible.
			background.finish();
			await background.outcome;
			await vi.waitFor(() => expect(updates).toHaveBeenLastCalledWith("background", undefined));
			foreground.finish();
			await foreground.outcome;
			expect(updates).toHaveBeenLastCalledWith("background", undefined);
			expect(service.list()).toHaveLength(3);
			handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			setKeybindings(previousKeybindings);
		}
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
	});

	it("renders one line per action with the task id and parameters", () => {
		const cases: [
			{
				action: "read" | "kill" | "list";
				taskId?: string;
				mode?: "head" | "tail";
				bytes?: number;
			},
			RegExp,
		][] = [
			[{ action: "read", taskId: "bg-3f", mode: "tail", bytes: 8192 }, /^tasks read bg-3f tail 8\.0KB\s*$/],
			[{ action: "read", taskId: "bg-3f", mode: "head" }, /^tasks read bg-3f head\s*$/],
			[{ action: "read", taskId: "bg-3f", bytes: 8192 }, /^tasks read bg-3f 8\.0KB\s*$/],
			[{ action: "read", taskId: "bg-3f" }, /^tasks read bg-3f\s*$/],
			[{ action: "kill", taskId: "bg-3f" }, /^tasks kill bg-3f/],
			[{ action: "list" }, /^tasks list/],
		];
		for (const [args, pattern] of cases) {
			const component = renderTasksCall(args as never, plainTheme, { expanded: false } as ToolRenderContext);
			const text = component.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(pattern);
		}
	});
});

describe("renderTasksResult", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("caps expanded output at the same end that was read", () => {
		const text = `[header]\nSTART-OF-REPORT\n${"x".repeat(4500)}\nEND-OF-REPORT`;
		const render = (mode: "head" | "tail") =>
			renderTasksResult(
				{
					content: [{ type: "text", text }],
					details: {
						action: "read",
						taskId: "report-1",
						mode,
						sliceBytes: 4500,
						totalBytes: 9000,
						outputPath: "",
					},
				},
				{ expanded: true, isPartial: false },
				plainTheme,
				{ args: { action: "read" }, state: {} } as ToolRenderContext,
			)
				.render(500)
				.join("\n");
		expect(render("head")).toContain("START-OF-REPORT");
		expect(render("head")).not.toContain("END-OF-REPORT");
		expect(render("tail")).toContain("END-OF-REPORT");
		expect(render("tail")).not.toContain("START-OF-REPORT");
	});

	it("shows the saved text of a persisted result from the removed wait action", () => {
		const component = renderTasksResult(
			{
				content: [{ type: "text", text: "[bg-3f completed] saved wait report" }],
				details: { action: "wait", outcome: "settled", taskId: "bg-3f" } as never,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			{ args: { action: "wait" }, state: {} } as ToolRenderContext,
		);
		expect(component.render(200).map(stripTerminalSequences).join("\n")).toContain("saved wait report");
	});

	it("shows the saved text of a result from an older tool version", () => {
		const component = renderTasksResult(
			{
				content: [{ type: "text", text: "Started background task bg-3f." }],
				details: { action: "create", taskId: "bg-3f" } as never,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			{ args: { action: "create" }, state: {} } as ToolRenderContext,
		);
		expect(component.render(200).map(stripTerminalSequences).join("\n")).toContain("Started background task bg-3f.");
	});
});
