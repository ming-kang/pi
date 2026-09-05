import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundService } from "../src/core/background/service.ts";
import type { BackgroundControl } from "../src/core/background/types.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
	ToolRenderContext,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { runKill, runList, runRead, runWait } from "../src/extensions/background/actions.ts";
import { createBackgroundExtension } from "../src/extensions/background/index.ts";
import {
	type BgRenderState,
	renderBackgroundNotification,
	renderBgCall,
	renderBgResult,
	scheduleWaitRefresh,
} from "../src/extensions/background/render.ts";
import type { bgSchema } from "../src/extensions/background/schema.ts";
import { formatStatusline } from "../src/extensions/background/task-view.ts";
import type { BgDetails, BgNotificationDetails } from "../src/extensions/background/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
const services: BackgroundService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	vi.useRealTimers();
});
function running(kind: "bash" | "subagent" = "bash") {
	const service = new BackgroundService({ enabled: true });
	services.push(service);
	let finish!: () => void;
	let control!: BackgroundControl<undefined>;
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
		let tool: ToolDefinition<typeof bgSchema, BgDetails, BgRenderState> | undefined;
		const pi = {
			on: vi.fn(),
			registerTool: (value: typeof tool) => {
				tool = value;
			},
			registerMessageRenderer: vi.fn(),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI;
		createBackgroundExtension()(pi);
		expect(tool?.name).toBe("bg");
		expect(tool?.renderShell).toBeUndefined();
		expect(JSON.stringify(tool?.parameters)).not.toContain('"create"');
		expect(JSON.stringify(tool?.parameters)).not.toContain('"command"');
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
		expect(finished.details.backgroundTaskId).toBe(id);
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
	it("keeps missing-log and terminal diagnostics ahead of a long fallback, including waits with no delta", async () => {
		const service = new BackgroundService({ enabled: true });
		services.push(service);
		await service.execute({
			kind: "bash",
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
	it("releases renderer timers when a pending wait row is disposed", () => {
		vi.useFakeTimers();
		const state: BgRenderState = {};
		const invalidate = vi.fn();
		const ctx = { state, invalidate } as unknown as ToolRenderContext<BgRenderState>;
		scheduleWaitRefresh(ctx, true);
		expect(vi.getTimerCount()).toBe(1);
		state.dispose?.();
		vi.advanceTimersByTime(2000);
		expect(invalidate).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("closes an open /bg via done on session shutdown without cancelling execution", async () => {
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
		createBackgroundExtension()(pi);
		const h = running();
		await h.outcome;
		const done = vi.fn();
		let menu: { dispose?(): void } | undefined;
		const ctx = {
			background: h.service,
			mode: "tui",
			ui: {
				setStatus: vi.fn(),
				custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
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
		createBackgroundExtension()(pi);
		const h = running();
		await h.outcome;
		const setStatus = vi.fn();
		const ctx = { background: h.service, ui: { setStatus } } as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("background", "bg 1 active · 0 finished");
		handlers.get("session_shutdown")?.({}, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("background", undefined);
		const calls = setStatus.mock.calls.length;
		h.finish();
		await h.service.wait(h.service.list()[0]!.id, 1000);
		expect(setStatus).toHaveBeenCalledTimes(calls);
	});
});

describe("renderBackgroundNotification", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const details: BgNotificationDetails = {
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

	function message(overrides?: Partial<BgNotificationDetails>): CustomMessage<BgNotificationDetails> {
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
		const collapsed = renderBackgroundNotification(message(), { expanded: false, outputPad: 1 }, plainTheme);
		expect(collapsed).toBeDefined();
		const collapsedLines = (collapsed?.render(120) ?? []).map(stripTerminalSequences);
		expect(collapsedLines.join("\n")).toContain("bg-abc123");
		expect(collapsedLines.join("\n")).toContain("completed, exit 0");
		expect(collapsedLines.join("\n")).not.toContain("build finished");
		// Collapsed keeps the row compact: file name only, not the full path.
		expect(collapsedLines.join("\n")).toContain("pi-bg-abc123.log");
		expect(collapsedLines.join("\n")).not.toContain("/tmp/pi-bg-abc123.log");

		const expanded = renderBackgroundNotification(message(), { expanded: true, outputPad: 1 }, plainTheme);
		const expandedLines = (expanded?.render(120) ?? []).map(stripTerminalSequences);
		expect(expandedLines.join("\n")).toContain("build finished");
		expect(expandedLines.join("\n")).toContain("/tmp/pi-bg-abc123.log");
	});

	it("bounds a wide-character command by display width, not code-point count", () => {
		// Each CJK code point occupies two terminal columns, so a count-based
		// truncation emits roughly twice the intended width and overflows the row.
		const command = "编译前端资源包".repeat(40);
		const collapsed = renderBackgroundNotification(
			message({ command }),
			{ expanded: false, outputPad: 1 },
			plainTheme,
		);
		const summary = ((collapsed?.render(400) ?? []).map(stripTerminalSequences)[0] ?? "").trimEnd();
		// 120 columns for the command, plus the glyph, id, and outcome.
		expect(visibleWidth(summary)).toBeLessThanOrEqual(200);

		// With a description the command gets the tighter 40-column budget, so the
		// row is shorter still, and the description survives.
		const labelled = renderBackgroundNotification(
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
		const expanded = renderBackgroundNotification(
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
			renderBackgroundNotification(
				message({ taskId: undefined as unknown as string }),
				{ expanded: false, outputPad: 1 },
				plainTheme,
			),
		).toBeUndefined();
	});

	it("renders a stalled notification as waiting-for-input with advice on expand", () => {
		const stalled = message({ stalled: true, status: "running", tailText: "Proceed? (y/n)\n" });

		const collapsed = renderBackgroundNotification(stalled, { expanded: false, outputPad: 1 }, plainTheme);
		const collapsedText = (collapsed?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("waiting for input");
		expect(collapsedText).not.toContain("(y/n)");

		const expanded = renderBackgroundNotification(stalled, { expanded: true, outputPad: 1 }, plainTheme);
		const expandedText = (expanded?.render(120) ?? []).map(stripTerminalSequences).join("\n");
		expect(expandedText).toContain("Proceed? (y/n)");
		expect(expandedText).toContain("kill");
	});
});

describe("renderBgCall", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("stays renderable while streaming incomplete arguments", () => {
		const empty = renderBgCall({} as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(empty.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg");

		const partialAction = renderBgCall({ action: "cre" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(partialAction.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg cre");

		const createWithoutCommand = renderBgCall({ action: "create" } as never, plainTheme, {
			expanded: false,
			isPartial: true,
		} as ToolRenderContext);
		expect(createWithoutCommand.render(200).map(stripTerminalSequences).join("\n").trimEnd()).toBe("bg create");
	});

	it("shows the full multi-line create command only when expanded", () => {
		const args = { action: "create" as const, command: "echo one\necho two\necho three" };

		const collapsed = renderBgCall(args, plainTheme, { expanded: false } as ToolRenderContext);
		const collapsedText = collapsed.render(200).map(stripTerminalSequences).join("\n");
		expect(collapsedText).toContain("+2 lines");
		expect(collapsedText).not.toContain("echo three");

		const expanded = renderBgCall(args, plainTheme, { expanded: true } as ToolRenderContext);
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
			[{ action: "read", taskId: "bg-3f", mode: "tail", bytes: 8192 }, /^bg read bg-3f tail/],
			[{ action: "wait", taskId: "3f", waitMs: 20_000 }, /^bg wait 3f 20s/],
			[{ action: "kill", taskId: "bg-3f" }, /^bg kill bg-3f/],
			[{ action: "list" }, /^bg list/],
		];
		for (const [args, pattern] of cases) {
			const component = renderBgCall(args as never, plainTheme, { expanded: false } as ToolRenderContext);
			const text = component.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(pattern);
		}
	});

	it("appends the description label to a create call", () => {
		const component = renderBgCall(
			{ action: "create", command: "npm run dev", description: "dev server" },
			plainTheme,
			{ expanded: false } as ToolRenderContext,
		);
		const text = component.render(200).map(stripTerminalSequences).join("\n");
		expect(text).toContain("npm run dev & · dev server");
	});
});

describe("renderBgCall wait live line", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("shows elapsed/window and the output delta while pending, then settles", () => {
		vi.useFakeTimers();
		try {
			const state: BgRenderState = {};
			let bytes = 100;
			const probe = () => ({ status: "running" as const, outputBytes: bytes });
			const context = {
				expanded: false,
				executionStarted: true,
				isPartial: true,
				state,
				invalidate: vi.fn(),
			} as unknown as ToolRenderContext<BgRenderState>;

			const first = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, probe);
			expect(first.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f waiting 0s\/20s/);
			expect(state.refreshTimer).toBeDefined();

			// Output grows; the armed timer invalidates and the next render shows the delta.
			bytes = 3378;
			vi.advanceTimersByTime(1000);
			expect(context.invalidate).toHaveBeenCalledTimes(1);
			const second = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, probe);
			const text = second.render(200).map(stripTerminalSequences).join("\n");
			expect(text).toMatch(/^bg wait bg-3f waiting 1s\/20s/);
			expect(text).toContain("+3.2KB new output");

			// Settled: timer cleared, static form returns.
			const settledContext = {
				expanded: false,
				executionStarted: true,
				isPartial: false,
				state,
			} as unknown as ToolRenderContext<BgRenderState>;
			const settled = renderBgCall(
				{ action: "wait", taskId: "bg-3f", waitMs: 20_000 },
				plainTheme,
				settledContext,
				probe,
			);
			expect(settled.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f 20s/);
			expect(state.refreshTimer).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stays static until execution starts", () => {
		const state: BgRenderState = {};
		// Arguments are still streaming, or this is a replayed transcript row that
		// will never settle. Either way there is nothing to count up to yet.
		const context = {
			expanded: false,
			executionStarted: false,
			isPartial: true,
			state,
		} as unknown as ToolRenderContext<BgRenderState>;

		const line = renderBgCall({ action: "wait", taskId: "bg-3f" }, plainTheme, context, () => ({
			status: "running" as const,
			outputBytes: 100,
		}));
		expect(line.render(200).map(stripTerminalSequences).join("\n")).not.toContain("waiting");
		expect(state.refreshTimer).toBeUndefined();
	});

	it("falls back to the static line without shell state", () => {
		const component = renderBgCall(
			{ action: "wait", taskId: "bg-3f", waitMs: 5000 },
			plainTheme,
			{ expanded: false, isPartial: true } as ToolRenderContext<BgRenderState>,
			() => ({ status: "running", outputBytes: 10 }),
		);
		expect(component.render(200).map(stripTerminalSequences).join("\n")).toMatch(/^bg wait bg-3f 5s/);
	});
});

describe("renderBgResult summaries", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	it("carries the description label on a create summary", () => {
		const component = renderBgResult(
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

describe("formatStatusline", () => {
	it("reports running and finished counts", () => {
		expect(formatStatusline({ running: 2, total: 3, stalled: 0 })).toBe("bg 2 running · 1 finished");
	});

	it("splits stalled tasks out of the running count so the counts add up", () => {
		expect(formatStatusline({ running: 3, total: 4, stalled: 1 })).toBe(
			"bg 2 running · 1 waiting for input · 1 finished",
		);
	});

	it("reports a lone stalled task without a running segment", () => {
		expect(formatStatusline({ running: 1, total: 1, stalled: 1 })).toBe("bg 1 waiting for input");
	});

	it("hides the segment when no tasks exist", () => {
		expect(formatStatusline({ running: 0, total: 0, stalled: 0 })).toBeUndefined();
	});
});
