import { stripTerminalSequences, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { TaskViewRegistry } from "../src/core/tasks/view.ts";
import { shellTaskView } from "../src/core/tools/renderers/shell-task.ts";
import { runWait } from "../src/core/tools/tasks/actions.ts";
import { TasksMenu } from "../src/modes/interactive/tasks/manager.ts";
import type { TasksPanelState } from "../src/modes/interactive/tasks/model.ts";
import { renderTasksResult } from "../src/modes/interactive/tasks/render.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const menus: TasksMenu[] = [];
const snapshot = (id: string, changes: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id,
	kind: "bash",
	format: "log",
	title: id,
	command: `echo ${id}`,
	mode: "background",
	status: "running",
	startedAt: 0,
	toolCallId: id,
	anchorId: null,
	...changes,
});
function panel(
	tasks: TaskSnapshot[],
	state: TasksPanelState = { filter: "overview", tab: "output", query: "" },
	width = 120,
	height = 30,
) {
	let notify = () => {};
	let output = Array.from({ length: 80 }, (_, i) => `output-${String(i).padStart(3, "0")}`).join("\n");
	const released = vi.fn();
	const host = {
		list: vi.fn(() => structuredClone(tasks)),
		read: vi.fn(async (id: string) => ({
			task: structuredClone(tasks.find((t) => t.id === id)!),
			text: output,
			totalBytes: 100_000,
			truncated: true,
		})),
		kill: vi.fn(() => true),
		detach: vi.fn(() => true),
		enabled: true,
		retain: vi.fn(() => released),
		subscribe: (fn: () => void) => {
			notify = fn;
			return vi.fn();
		},
	};
	const views = new TaskViewRegistry();
	views.register("bash", shellTaskView);
	const tui = { terminal: { rows: height, columns: width }, requestRender: vi.fn() };
	const keybindings = new KeybindingsManager();
	const menu = new TasksMenu({ host, views, state, tui, theme, keybindings, onClose: vi.fn() });
	menus.push(menu);
	return {
		menu,
		tasks,
		host,
		released,
		state,
		views,
		tui,
		keybindings,
		notify: () => notify(),
		output: (text: string) => {
			output = text;
		},
		frame: () => menu.render(tui.terminal.columns).map(stripTerminalSequences).join("\n"),
	};
}
function mouse(x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 120,
		height: 30,
		shift: false,
		ctrl: false,
		alt: false,
		...extra,
	};
}
beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
	vi.setSystemTime(1000);
});
afterEach(() => {
	for (const menu of menus.splice(0)) menu.dispose();
	vi.useRealTimers();
});

describe("Tasks redesign behavior", () => {
	it("replaces pending cancellation feedback when the executor confirms settlement", () => {
		const h = panel([snapshot("build")]);
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.frame()).toContain("waiting for cleanup");
		h.tasks[0]!.status = "cancelled";
		h.tasks[0]!.endedAt = 1000;
		h.notify();
		expect(h.frame()).toContain("Cancelled");
		expect(h.frame()).not.toContain("waiting for cleanup");
	});
	it("keeps output polling bounded while the executor publishes frequent progress", async () => {
		const h = panel([snapshot("build")]);
		await vi.advanceTimersByTimeAsync(0);
		const reads = h.host.read.mock.calls.length;
		for (let i = 0; i < 8; i++) {
			h.notify();
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		await vi.advanceTimersByTimeAsync(200);
		expect(h.host.read).toHaveBeenCalledTimes(reads + 1);
	});
	it("keeps a settled task selectable and restores its selection on reopen", async () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		await vi.advanceTimersByTimeAsync(0);
		h.tasks[0]!.status = "failed";
		h.tasks[0]!.endedAt = 1000;
		h.output("build failure output");
		h.notify();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("Recent");
		expect(h.frame()).toContain("build failure output");
		expect(h.state.selectedId).toBe("build");
		h.menu.dispose();
		expect(h.released).toHaveBeenCalledOnce();
		const reopened = panel(h.tasks, h.state);
		expect(reopened.state.selectedId).toBe("build");
		expect(reopened.frame()).toContain("Failed");
	});
	it("provides ongoing, recent and full retained history without flooding Overview with foreground logs", () => {
		const h = panel([
			snapshot("live"),
			snapshot("inline", { mode: "foreground", status: "completed", endedAt: 1 }),
			...Array.from({ length: 7 }, (_, i) => snapshot(`done-${i}`, { status: "completed", endedAt: i + 1 })),
		]);
		expect(h.frame()).not.toContain("echo inline");
		h.menu.handleInput("3");
		expect(h.frame()).toContain("echo inline");
		expect(h.frame()).not.toContain("echo live");
		h.menu.handleInput("2");
		expect(h.frame()).toContain("echo live");
		expect(h.frame()).not.toContain("echo done-");
	});
	it("labels a selected Active task that just finished and releases it on another selection", () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.menu.handleInput("2");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.notify();
		expect(h.frame()).toContain("Just finished");
		expect(h.state.selectedId).toBe("build");
		h.menu.handleInput("\x1b[B");
		expect(h.frame()).not.toContain("Just finished");
		expect(h.state.selectedId).toBe("check");
	});
	it("filters identity and labels without leaving an invisible cancellation target", () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.menu.handleInput("/");
		h.menu.handleInput("check");
		h.menu.handleInput("\r");
		expect(h.frame()).not.toContain("echo build");
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledWith("check");
		h.menu.handleInput("/");
		h.menu.handleInput("missing");
		h.menu.handleInput("\r");
		expect(h.frame()).toContain("No matching tasks");
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledTimes(1);
	});
	it("lets configurable selected detach and confirmation act on only the selected task", () => {
		const h = panel([snapshot("build", { mode: "foreground" }), snapshot("check", { mode: "foreground" })]);
		h.keybindings.setUserBindings({ "app.tasks.detachSelected": "d", "app.tasks.confirmStop": "c" });
		h.menu.handleInput("d");
		expect(h.host.detach).toHaveBeenCalledExactlyOnceWith("build");
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("k");
		h.menu.handleInput("c");
		expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
	});
	it("loads final output only when explicitly resuming a browsed preview", async () => {
		const h = panel([snapshot("build")]);
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\x1b[C");
		h.menu.handleInput("\x1b[H");
		expect(h.frame()).toContain("output-000");
		h.output("final output");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.notify();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame()).toContain("load final output");
		expect(h.frame()).not.toContain("\nfinal output");
		h.menu.handleInput("f");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("final output");
	});
	it("gives a narrow inspector twelve output lines and keeps metadata behind Information", async () => {
		const h = panel([snapshot("build", { cwd: "/project" })], undefined, 72, 22);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).not.toContain("output-079");
		h.menu.handleInput("\r");
		expect(h.frame().match(/output-\d+/g)?.length).toBeGreaterThanOrEqual(12);
		expect(h.frame()).not.toContain("/project");
		h.menu.handleInput("i");
		expect(h.frame()).toContain("/project");
		h.menu.handleInput("\x1b");
		expect(h.frame()).not.toContain("/project");
		for (const line of h.menu.render(72)) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
	});
	it("supports mouse selection, tab switching and wheel browsing", async () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		await vi.advanceTimersByTimeAsync(0);
		let row = h
			.frame()
			.split("\n")
			.findIndex((line) => line.includes("echo check"));
		h.menu.handleMouse(mouse(5, row));
		expect(h.state.selectedId).toBe("check");
		await vi.advanceTimersByTimeAsync(0);
		const lines = h.frame().split("\n");
		row = lines.findIndex((line) => line.includes("Information"));
		const x = lines[row]!.indexOf("Information");
		h.menu.handleMouse(mouse(x, row));
		expect(h.state.tab).toBe("info");
		h.menu.handleInput("\x1b[C");
		h.menu.handleMouse(mouse(70, 10, { type: "wheel", button: "none", wheelDelta: -3 }));
		expect(h.frame()).toContain("Browsing");
	});
	it("animates the visible marker without cloning task history or reading logs on each frame", async () => {
		const h = panel([snapshot("build")]);
		await vi.advanceTimersByTimeAsync(0);
		const before = h.frame(),
			reads = h.host.read.mock.calls.length,
			lists = h.host.list.mock.calls.length;
		await vi.advanceTimersByTimeAsync(360);
		expect(h.frame()).not.toBe(before);
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		expect(h.host.list).toHaveBeenCalledTimes(lists);
	});
	it("falls back to live bounded reads if a custom log provider fails", async () => {
		const h = panel([snapshot("custom", { kind: "custom" })]);
		h.views.register("custom", {
			outputMode: "tail",
			create: () => ({
				info: new Text("", 0, 0),
				output: {
					render() {
						throw new Error("view broke");
					},
					invalidate() {},
				},
				update() {},
			}),
		});
		h.output("live fallback");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("live fallback");
		expect(h.frame()).toContain("view broke");
	});
	it("shows explicit empty output and bounded preview size", async () => {
		const h = panel([snapshot("build")]);
		h.output("");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("No output yet");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.notify();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("Completed with no output");
	});
	it("drops a selected task when it leaves the visible branch", () => {
		const h = panel([snapshot("old"), snapshot("new")]);
		h.tasks.shift();
		h.notify();
		expect(h.frame()).not.toContain("echo old");
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledWith("new");
	});
});

describe("management outcome facts", () => {
	it.each([0, 42, null])("preserves terminal exit code %s in wait results", async (exitCode) => {
		const runtime = new TaskRuntime();
		try {
			await runtime.execute({
				kind: "bash",
				format: "log",
				title: "build",
				toolCallId: "call",
				run: async () => ({
					status: exitCode === 0 ? "completed" : "failed",
					exitCode,
					result: { content: [{ type: "text", text: "saved output" }], details: undefined },
				}),
			});
			const task = runtime.list()[0]!;
			const result = await runWait(runtime, { action: "wait", taskId: task.id });
			expect(result.details.exitCode).toBe(exitCode);
		} finally {
			await runtime.shutdown();
		}
	});
	it("does not call stopping work running when a wait ends", () => {
		const result = renderTasksResult(
			{
				content: [],
				details: {
					action: "wait",
					taskId: "build",
					timedOut: true,
					status: "stopping",
					exitCode: undefined,
					waitedMs: 1000,
					deltaBytes: 0,
					totalBytes: 0,
					deltaTruncated: false,
					outputPath: "",
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ state: {} } as ToolRenderContext,
		);
		const text = result.render(120).map(stripTerminalSequences).join("\n");
		expect(text).toContain("Stopping");
		expect(text).not.toContain("still running");
	});
});
