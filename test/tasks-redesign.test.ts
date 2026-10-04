import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { runWait } from "../src/core/tools/tasks/actions.ts";
import { TasksMenu } from "../src/modes/interactive/tasks/manager.ts";
import type { TasksPanelState } from "../src/modes/interactive/tasks/model.ts";
import { renderTasksResult } from "../src/modes/interactive/tasks/render.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const menus: TasksMenu[] = [];
const snapshot = (id: string, changes: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id,
	kind: "bash",
	title: id,
	command: `echo ${id}`,
	mode: "background",
	status: "running",
	startedAt: 0,
	toolCallId: id,
	anchorId: null,
	...changes,
});
function panel(tasks: TaskSnapshot[], state: TasksPanelState = { tab: "output" }, width = 120, height = 30) {
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
	const tui = { terminal: { rows: height, columns: width }, requestRender: vi.fn() };
	const keybindings = new KeybindingsManager();
	const menu = new TasksMenu({ host, state, tui, theme, keybindings, onClose: vi.fn() });
	menus.push(menu);
	return {
		menu,
		tasks,
		host,
		released,
		state,
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
	it("keeps task selection visible when the terminal cannot report background colors", () => {
		initTheme("system");
		const h = panel([snapshot("build"), snapshot("check")]);
		const selected = () => h.menu.render(120).find((line) => stripTerminalSequences(line).includes("echo build"))!;
		expect(selected()).toContain("\x1b[7m");
		h.menu.handleInput("\t");
		expect(selected()).toContain("\x1b[7m");
	});
	it.each([60, 72, 120])("keeps help and confirmation inside a short terminal at width %i", (width) => {
		const h = panel([snapshot("界".repeat(300))], undefined, width, 14);
		for (const key of ["?", "\x1b", "k"]) {
			h.menu.handleInput(key);
			const lines = h.menu.render(width);
			expect(lines.length).toBeLessThanOrEqual(14);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
		expect(h.frame()).toContain("whole task");
		expect(h.frame()).toContain("Task ID:");
	});
	it("switches only two panes and preserves the right tab, with border-only focus", async () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		await vi.advanceTimersByTimeAsync(0);
		const before = h.menu.render(120);
		h.menu.handleInput("\x1b[C");
		h.menu.handleInput("\r");
		h.menu.handleInput("f");
		expect(h.menu.render(120)).toEqual(before);
		h.menu.handleInput("\t");
		const after = h.menu.render(120);
		const row = before.findIndex((line) => stripTerminalSequences(line).includes("echo build"));
		// Content, including selected background, is identical when only focus changes.
		const selectedContent = (line: string) => line.split("│")[1]!.replace(/\x1b\[[\d;]+m$/, "");
		expect(selectedContent(after[row]!)).toBe(selectedContent(before[row]!));
		expect(after[0]).not.toBe(before[0]);
		expect(h.frame().split("\n").slice(0, -1).join("\n")).not.toMatch(/[→›]/);
		h.menu.handleInput("\x1b[C");
		expect(h.state.tab).toBe("info");
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
		h.menu.handleInput("\x1b[Z");
		expect(h.state.tab).toBe("info");
		h.menu.handleInput("\x1b[D");
		expect(h.state.tab).toBe("output");
		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
	});
	it("keeps search, help and stop input inside their own interaction", async () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.menu.handleInput("/");
		h.menu.handleInput("check");
		h.menu.handleInput("\x1b");
		expect(h.state.selectedId).toBe("build");
		h.menu.handleInput("?");
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("\x1b");
		h.menu.handleInput("k");
		await vi.advanceTimersByTimeAsync(8000);
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("\t");
		expect(h.state.selectedId).toBe("build");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
	});
	it("lists both detach scopes in the panel help", () => {
		const h = panel([snapshot("build", { mode: "foreground" })]);
		h.menu.handleInput("?");
		const help = h.frame();
		expect(help).toContain("Ctrl+B");
		expect(help).toContain("Move every eligible foreground execution to the background");
		expect(help).toContain("Move selected foreground task to background");
	});
	it("keeps footer hint hits while transient feedback replaces the hint row", () => {
		const h = panel([snapshot("build", { mode: "foreground" })]);
		const hints = h.frame().split("\n").at(-1)!;
		// The stop hint keeps its click target even while feedback owns the row.
		const stop = hints.indexOf("stop");
		h.menu.handleInput("b");
		expect(h.frame().split("\n").at(-1)).toContain("Selected task moved to background");
		h.menu.handleMouse(mouse(stop, 29));
		expect(h.frame()).toContain("Stop task?");
	});
	it("dismisses stop when its target finishes without stopping the next selection", () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.menu.handleInput("k");
		h.tasks[0]!.status = "completed";
		h.notify();
		expect(h.frame()).not.toContain("confirm");
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("\r");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("scrolls the hovered output without taking keyboard focus", async () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleMouse(mouse(70, 10, { type: "wheel", button: "none", wheelDelta: -3 }));
		expect(h.frame()).toContain("Browsing");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
	});
	it("locates a search candidate by click and clears the query", () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.menu.handleInput("/");
		h.menu.handleInput("check");
		const row = h
			.frame()
			.split("\n")
			.findIndex((line) => line.includes("echo check"));
		h.menu.handleMouse(mouse(5, row));
		expect(h.state.selectedId).toBe("check");
		expect(h.frame()).toContain("echo build");
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("check");
	});
	it("keeps a long list anchored as work completes and new work arrives", () => {
		const h = panel([
			...Array.from({ length: 30 }, (_, i) => snapshot(`task-${String(i).padStart(2, "0")}`)),
			...Array.from({ length: 30 }, (_, i) => snapshot(`done-${i}`, { status: "completed", endedAt: 1 })),
		]);
		h.menu.handleInput("/");
		h.menu.handleInput("task-15");
		h.menu.handleInput("\r");
		const row = () =>
			h
				.frame()
				.split("\n")
				.findIndex((line) => line.includes("echo task-15"));
		const before = row();
		h.tasks[15]!.status = "completed";
		h.tasks[15]!.endedAt = 1000;
		h.notify();
		expect(row()).toBe(before);
		h.tasks.push(snapshot("new", { startedAt: 2000 }));
		h.notify();
		expect(row()).toBe(before);
		expect(h.state.selectedId).toBe("task-15");
	});
	it("keeps a visible selection reachable when the terminal becomes shorter", () => {
		const h = panel(Array.from({ length: 30 }, (_, i) => snapshot(`task-${String(i).padStart(2, "0")}`)));
		for (let i = 0; i < 10; i++) h.menu.handleInput("\x1b[B");
		expect(h.frame()).toContain("echo task-10");
		h.tui.terminal.rows = 14;
		expect(h.frame()).toContain("echo task-10");
	});
	it("replaces pending cancellation feedback when the executor confirms settlement", () => {
		const h = panel([snapshot("build")]);
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
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
		expect(h.frame()).toContain("Finished");
		expect(h.frame()).toContain("build failure output");
		expect(h.state.selectedId).toBe("build");
		h.menu.dispose();
		expect(h.released).toHaveBeenCalledOnce();
		const reopened = panel(h.tasks, h.state);
		expect(reopened.state.selectedId).toBe("build");
		expect(reopened.frame()).toContain("Failed");
	});
	it("locates all retained results and returns to the complete list", () => {
		const h = panel([
			snapshot("live"),
			snapshot("inline", { mode: "foreground", status: "completed", endedAt: 1 }),
			...Array.from({ length: 20 }, (_, i) => snapshot(`done-${i}`, { status: "completed", endedAt: i + 2 })),
		]);
		expect(h.frame()).not.toContain("Overview");
		h.menu.handleInput("/");
		h.menu.handleInput("inline");
		h.menu.handleInput("\r");
		expect(h.state.selectedId).toBe("inline");
		h.menu.handleInput("\x1b[H");
		expect(h.frame()).toContain("echo live");
		h.menu.handleInput("/");
		h.menu.handleInput("missing");
		expect(h.frame()).toContain("No matching tasks");
		h.menu.handleInput("\r");
		h.menu.handleInput("k");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("\x1b");
		expect(h.state.selectedId).toBe("live");
	});
	it("keeps completed tasks in Finished after choosing another task", () => {
		const h = panel([snapshot("build"), snapshot("check")]);
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.notify();
		expect(h.frame()).toContain("Finished");
		expect(h.state.selectedId).toBe("build");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
		expect(h.frame()).toContain("echo build");
	});
	it("lets configurable selected detach and confirmation act on only the selected task", () => {
		const h = panel([snapshot("build", { mode: "foreground" }), snapshot("check", { mode: "foreground" })]);
		h.keybindings.setUserBindings({ "app.tasks.detachSelected": "d", "app.tasks.confirmStop": "c" });
		h.menu.handleInput("d");
		expect(h.host.detach).toHaveBeenCalledExactlyOnceWith("build");
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("k");
		h.menu.handleInput("c");
		expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
	});
	it("loads final output only when explicitly resuming a browsed preview", async () => {
		const h = panel([snapshot("build")]);
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\t");
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
	it("gives a narrow inspector twelve output lines and keeps metadata behind Details", async () => {
		const h = panel([snapshot("build", { cwd: "/project" })], undefined, 72, 22);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).not.toContain("output-079");
		h.menu.handleInput("\t");
		expect(h.frame().match(/output-\d+/g)?.length).toBeGreaterThanOrEqual(12);
		expect(h.frame()).not.toContain("/project");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("/project");
		h.menu.handleInput("\t");
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
		row = lines.findIndex((line) => line.includes("Details"));
		const x = lines[row]!.indexOf("Details");
		h.menu.handleMouse(mouse(x, row));
		expect(h.state.tab).toBe("info");
		h.menu.handleInput("\x1b[D");
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
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledWith("new");
	});
});

describe("management outcome facts", () => {
	it.each([0, 42, null])("preserves terminal exit code %s in wait results", async (exitCode) => {
		const runtime = new TaskRuntime();
		try {
			await runtime.execute({
				kind: "bash",
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
