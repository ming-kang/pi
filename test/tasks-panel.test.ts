import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { type TaskViewProvider, TaskViewRegistry } from "../src/core/tasks/view.ts";
import { shellTaskView } from "../src/core/tools/renderers/shell-task.ts";
import { TasksMenu } from "../src/modes/interactive/tasks/manager.ts";
import type { TasksPanelState } from "../src/modes/interactive/tasks/model.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const menus: TasksMenu[] = [];
function task(id: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id,
		kind: "bash",
		format: "log",
		title: id,
		command: `echo ${id}`,
		mode: "foreground",
		status: "running",
		startedAt: 0,
		toolCallId: id,
		anchorId: null,
		...overrides,
	};
}
function harness(tasks = [task("first"), task("second", { mode: "background" })], width = 140) {
	const views = new TaskViewRegistry();
	views.register("bash", shellTaskView);
	let listener = () => {};
	let output = Array.from({ length: 80 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
	const release = vi.fn();
	const host = {
		list: () => structuredClone(tasks),
		read: vi.fn(async (id: string) => ({
			task: structuredClone(tasks.find((t) => t.id === id)!),
			text: output,
			totalBytes: output.length,
			truncated: false,
		})),
		kill: vi.fn(() => true),
		retain: vi.fn(() => release),
		subscribe: (fn: () => void) => {
			listener = fn;
			return vi.fn();
		},
	};
	const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: width } };
	const close = vi.fn();
	const keybindings = new KeybindingsManager();
	const state: TasksPanelState = { tab: "output" };
	const menu = new TasksMenu({ host, views, tui, theme, keybindings, state, onClose: close });
	menus.push(menu);
	return {
		menu,
		state,
		tasks,
		host,
		views,
		tui,
		close,
		keybindings,
		release,
		change: () => listener(),
		setOutput: (text: string) => {
			output = text;
		},
		frame: () => menu.render(width).map(stripTerminalSequences).join("\n"),
		left: () =>
			menu
				.render(width)
				.map((line) => stripTerminalSequences(line).split("│")[1])
				.join("\n"),
	};
}
describe("task panel views", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		initTheme("dark");
	});
	afterEach(() => {
		for (const menu of menus.splice(0)) menu.dispose();
		vi.useRealTimers();
	});
	it("lists ongoing and retained foreground tasks together", async () => {
		const h = harness([
			task("fg"),
			task("bg", { mode: "background" }),
			task("queue", { status: "queued" }),
			task("stop", { status: "stopping" }),
			task("old", { status: "completed" }),
		]);
		await vi.advanceTimersByTimeAsync(0);
		for (const label of ["fg", "bg", "queue", "stop"]) expect(h.left()).toContain(label);
		expect(h.left()).toContain("old");
		expect(h.frame()).toContain("Finished");
	});
	it("keeps foreground completions in the list after another selection", async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(0);
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.setOutput("final report");
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.left()).toContain("echo first");
		expect(h.frame()).toContain("final report");
		expect(h.frame()).toContain("Completed");
		const reads = h.host.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		h.menu.handleInput("k");
		expect(h.frame()).not.toContain("y/N");
		h.menu.handleInput("\x1b[B");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("echo second");
		expect(h.frame()).toContain("echo first");
		expect(h.release).toHaveBeenCalledOnce();
	});
	it("keeps a watched result when new work arrives and exposes foreground history on reopen", async () => {
		const h = harness([task("first")]);
		await vi.advanceTimersByTimeAsync(0);
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame()).toContain("Finished");
		h.tasks.push(task("new"));
		h.change();
		expect(h.frame()).toContain("echo first");
		expect(h.left()).toContain("echo new");
		const reopened = harness(h.tasks);
		expect(reopened.frame()).toContain("echo new");
		expect(reopened.frame()).toContain("echo first");
	});
	it("keeps a stable selection while tasks arrive and reorder", () => {
		const h = harness();
		h.tasks.unshift(task("new", { startedAt: 500 }));
		h.tasks.reverse();
		h.change();
		h.frame();
		expect(h.state.selectedId).toBe("first");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("second");
	});
	it("lets a provider own both regions and disposes its view when replaced", async () => {
		const h = harness([task("custom", { kind: "custom", format: "report" })]);
		const dispose = vi.fn();
		const provider: TaskViewProvider = {
			outputMode: "snapshot",
			create: () => ({
				info: new Text("Custom parameters", 0, 0),
				output: new Text("A custom report structure", 0, 0),
				update: vi.fn(),
				dispose,
			}),
		};
		const unregister = h.views.register("custom", provider);
		expect(h.frame()).toContain("A custom report structure");
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("Custom parameters");
		h.menu.handleInput("\x1b[D");
		expect(h.host.read).not.toHaveBeenCalled();
		h.tasks[0]!.result = { content: [{ type: "text", text: "Saved fallback" }], details: undefined };
		h.change();
		unregister();
		expect(h.frame()).toContain("Saved fallback");
		expect(dispose).toHaveBeenCalledOnce();
	});
	it("contains provider failures and keeps task controls usable", () => {
		const h = harness([task("broken", { kind: "broken" })]);
		h.views.register("broken", {
			outputMode: "snapshot",
			create: () => {
				throw new Error("broken renderer");
			},
		});
		expect(() => h.frame()).not.toThrow();
		expect(h.frame()).toContain("broken renderer");
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledWith("broken");
	});
	it("renders CRLF shell output as one row per line", async () => {
		const h = harness();
		h.setOutput("first line\r\nsecond line\r\n");
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame().match(/first line|second line/g)).toEqual(["first line", "second line"]);
	});
	it("pauses tail following while browsing and resumes only on explicit downward navigation", async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[5~");
		const before = h.frame().match(/line-\d+/g);
		h.setOutput("new tail");
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame().match(/line-\d+/g)).toEqual(before);
		expect(h.frame()).toContain("Browsing");
		for (let i = 0; i < 10; i++) h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("new tail");
		expect(h.frame()).toContain("Live");
	});
	it("ignores a pending read after selection changes or the panel closes", async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(0);
		let resolve!: (value: Awaited<ReturnType<typeof h.host.read>>) => void;
		h.host.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\x1b[B");
		resolve({ task: h.tasks[0]!, text: "stale first output", totalBytes: 1, truncated: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).not.toContain("stale first output");
		h.menu.dispose();
		const renders = h.tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.tui.requestRender).toHaveBeenCalledTimes(renders);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("scrolls long information independently and honors rebound controls", () => {
		const h = harness([task("custom", { kind: "custom" })]);
		h.views.register("custom", {
			outputMode: "snapshot",
			create: () => ({
				info: new Text(Array.from({ length: 50 }, (_, i) => `parameter-${i}`).join("\n"), 0, 0),
				output: new Text("Report", 0, 0),
				update: vi.fn(),
			}),
		});
		h.keybindings.setUserBindings({ "app.tasks.nextTab": "i", "app.tasks.kill": "x" });
		h.menu.handleInput("\t");
		h.menu.handleInput("i");
		expect(h.frame()).toContain("parameter-0");
		h.menu.handleInput("\x1b[6~");
		expect(h.frame()).not.toContain("parameter-0 ");
		h.menu.handleInput("\x1b[D");
		expect(h.frame()).toContain("Report");
		h.menu.handleInput("k");
		expect(h.frame()).not.toContain("confirm");
		h.menu.handleInput("x");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledWith("custom");
	});
	it.each([2, 50, 60, 100, 140])("fits the terminal at width %i with wide unicode output", async (width) => {
		const h = harness([task("unicode")], width);
		h.setOutput("界".repeat(500));
		await vi.advanceTimersByTimeAsync(1000);
		for (const line of h.menu.render(width)) expect(visibleWidth(line)).toBe(width);
		expect(h.menu.render(width).length).toBeLessThanOrEqual(h.tui.terminal.rows);
	});
	it("retains browsing across rolling tails, settlement, selection and resize", async () => {
		const h = harness();
		h.setOutput(Array.from({ length: 80 }, (_, i) => `entry-${i}: ${"界".repeat(60)}`).join("\n"));
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[5~");
		const first = h.frame().match(/entry-\d+/)?.[0];
		expect(first).toBeDefined();
		expect(h.menu.render(60).map(stripTerminalSequences).join("\n")).toContain(first);
		h.menu.render(140);
		h.setOutput("final tail");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame()).toContain(first);
		expect(h.frame()).not.toContain("final tail");
		for (let i = 0; i < 20; i++) h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("final tail");
	});
	it("does not replace the browsed snapshot with an already pending tail read", async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(0);
		let resolve!: (value: Awaited<ReturnType<typeof h.host.read>>) => void;
		h.host.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[5~");
		const before = h.frame().match(/line-\d+/g);
		resolve({ task: h.tasks[0]!, text: "late tail", totalBytes: 9, truncated: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame().match(/line-\d+/g)).toEqual(before);
	});
	it("animates without extra log reads and stops animation after settlement", async () => {
		const h = harness([task("one")]);
		await vi.advanceTimersByTimeAsync(0);
		const reads = h.host.read.mock.calls.length;
		h.tui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(600);
		expect(h.tui.requestRender.mock.calls.length).toBeGreaterThan(2);
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = Date.now();
		h.change();
		await vi.advanceTimersByTimeAsync(0);
		h.tui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(600);
		expect(h.tui.requestRender).not.toHaveBeenCalled();
	});
	it("keeps stop confirmation until cancelled and closes directly from output", async () => {
		const h = harness();
		h.menu.handleInput("k");
		expect(h.frame()).toContain("confirm");
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.frame()).toContain("confirm");
		h.menu.handleInput("\x1b");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b");

		expect(h.close).toHaveBeenCalledOnce();
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("keeps missing-log diagnostics readable alongside a long output fallback", async () => {
		const h = harness([task("one")]);
		await vi.advanceTimersByTimeAsync(0);
		h.host.read.mockRejectedValue(new Error("ENOENT: log expired"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame()).toContain("Cannot read output:");
		expect(h.frame()).toContain("ENOENT");
	});
	it("windows long lists and honors separate list/output page bindings", async () => {
		const h = harness(Array.from({ length: 40 }, (_, i) => task(`task-${String(i).padStart(2, "0")}`)));
		h.keybindings.setUserBindings({ "tui.select.pageDown": "n", "tui.editor.pageUp": "p" });
		expect(h.left()).not.toContain("task-39");
		h.menu.handleInput("\x1b[A");
		expect(h.state.selectedId).toBe("task-39");
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("n");
		expect(h.state.selectedId).toBe("task-12");
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\t");
		h.menu.handleInput("p");
		expect(h.frame()).toContain("Browsing");
	});
});
