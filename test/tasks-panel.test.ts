import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { TasksMenu } from "../src/modes/interactive/tasks/manager.ts";
import type { TasksPanelState } from "../src/modes/interactive/tasks/model.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const menus: TasksMenu[] = [];
function task(id: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id,
		kind: "bash",
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
function harness(
	tasks = [task("first"), task("second", { mode: "background" })],
	{
		width = 140,
		height = 30,
		state = { tab: "output" },
	}: { width?: number; height?: number; state?: TasksPanelState } = {},
) {
	let listener = () => {};
	let output = Array.from({ length: 80 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
	const release = vi.fn();
	const host = {
		list: vi.fn(() => structuredClone(tasks)),
		read: vi.fn(async (id: string) => ({
			task: structuredClone(tasks.find((t) => t.id === id)!),
			text: output,
			totalBytes: output.length,
			truncated: false,
		})),
		kill: vi.fn(() => true),
		detach: vi.fn(() => true),
		enabled: true,
		retain: vi.fn(() => release),
		subscribe: (fn: () => void) => {
			listener = fn;
			return vi.fn();
		},
	};
	const tui = { requestRender: vi.fn(), terminal: { rows: height, columns: width } };
	const close = vi.fn();
	const keybindings = new KeybindingsManager();
	const menu = new TasksMenu({ host, tui, theme, keybindings, state, onClose: close });
	menus.push(menu);
	return {
		menu,
		state,
		tasks,
		host,
		tui,
		close,
		keybindings,
		release,
		change: () => listener(),
		setOutput: (text: string) => {
			output = text;
		},
		frame: () => menu.render(tui.terminal.columns).map(stripTerminalSequences).join("\n"),
		left: () =>
			menu
				.render(width)
				.map((line) => stripTerminalSequences(line).split("│")[1])
				.join("\n"),
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
const backgroundTask = (id: string, overrides: Partial<TaskSnapshot> = {}) =>
	task(id, { mode: "background", ...overrides });
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
	it("colors every output line, not only the first", async () => {
		const h = harness([task("one")]);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.menu.render(140).join("\n");
		for (const line of ["line-070", "line-079"]) expect(frame).toContain(theme.fg("toolOutput", line));
	});
	it("shows a task without a command by its title and kind", async () => {
		const h = harness([task("review", { kind: "review", command: undefined, title: "Inspect boundaries" })]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.left()).toContain("Inspect boundaries");
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("review");
		expect(h.frame()).toContain("Title     Inspect boundaries");
	});
	it("scrolls long information independently and honors rebound controls", async () => {
		const command = Array.from({ length: 50 }, (_, i) => `echo parameter-${i}`).join("\n");
		const h = harness([task("custom", { kind: "custom", command })]);
		await vi.advanceTimersByTimeAsync(0);
		h.keybindings.setUserBindings({ "app.tasks.nextTab": "i", "app.tasks.kill": "x" });
		h.menu.handleInput("\t");
		h.menu.handleInput("i");
		expect(h.frame()).toContain("parameter-0");
		h.menu.handleInput("\x1b[6~");
		expect(h.frame()).not.toContain("echo parameter-1 ");
		h.menu.handleInput("\x1b[D");
		expect(h.frame()).toContain("line-079");
		h.menu.handleInput("k");
		expect(h.frame()).not.toContain("confirm");
		h.menu.handleInput("x");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledWith("custom");
	});
	it.each([2, 60, 140])("fits the terminal at width %i with wide unicode output", async (width) => {
		const h = harness([task("unicode")], { width });
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
describe("task panel interaction", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		initTheme("dark");
	});
	afterEach(() => {
		for (const menu of menus.splice(0)) menu.dispose();
		vi.useRealTimers();
	});
	it("keeps task selection visible when the terminal cannot report background colors", () => {
		initTheme("system");
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		const selected = () => h.menu.render(120).find((line) => stripTerminalSequences(line).includes("echo build"))!;
		expect(selected()).toContain("\x1b[7m");
		h.menu.handleInput("\t");
		expect(selected()).toContain("\x1b[7m");
	});
	it.each([60, 120])("keeps help and confirmation inside a short terminal at width %i", (width) => {
		const h = harness([backgroundTask("界".repeat(300))], { width: width, height: 14 });
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
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
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
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
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
	it("keeps footer hint hits while transient feedback replaces the hint row", () => {
		const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
		const hints = h.frame().split("\n").at(-1)!;
		// The stop hint keeps its click target even while feedback owns the row.
		const stop = hints.indexOf("stop");
		h.menu.handleInput("b");
		expect(h.frame().split("\n").at(-1)).toContain("Selected task moved to background");
		h.menu.handleMouse(mouse(stop, 29));
		expect(h.frame()).toContain("Stop task?");
	});
	it("dismisses stop when its target finishes without stopping the next selection", () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		h.menu.handleInput("k");
		h.tasks[0]!.status = "completed";
		h.change();
		expect(h.frame()).not.toContain("confirm");
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("\r");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("scrolls the hovered output without taking keyboard focus", async () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleMouse(mouse(70, 10, { type: "wheel", button: "none", wheelDelta: -3 }));
		expect(h.frame()).toContain("Browsing");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
	});
	it("locates a search candidate by click and clears the query", () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
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
		const h = harness([
			...Array.from({ length: 30 }, (_, i) => backgroundTask(`task-${String(i).padStart(2, "0")}`)),
			...Array.from({ length: 30 }, (_, i) => backgroundTask(`done-${i}`, { status: "completed", endedAt: 1 })),
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
		h.change();
		expect(row()).toBe(before);
		h.tasks.push(backgroundTask("new", { startedAt: 2000 }));
		h.change();
		expect(row()).toBe(before);
		expect(h.state.selectedId).toBe("task-15");
	});
	it("keeps a visible selection reachable when the terminal becomes shorter", () => {
		const h = harness(Array.from({ length: 30 }, (_, i) => backgroundTask(`task-${String(i).padStart(2, "0")}`)));
		for (let i = 0; i < 10; i++) h.menu.handleInput("\x1b[B");
		expect(h.frame()).toContain("echo task-10");
		h.tui.terminal.rows = 14;
		expect(h.frame()).toContain("echo task-10");
	});
	it("replaces pending cancellation feedback when the executor confirms settlement", () => {
		const h = harness([backgroundTask("build")], { width: 120 });
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.frame()).toContain("waiting for cleanup");
		h.tasks[0]!.status = "cancelled";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		expect(h.frame()).toContain("Cancelled");
		expect(h.frame()).not.toContain("waiting for cleanup");
	});
	it("keeps output polling bounded while the executor publishes frequent progress", async () => {
		const h = harness([backgroundTask("build")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		const reads = h.host.read.mock.calls.length;
		for (let i = 0; i < 8; i++) {
			h.change();
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		await vi.advanceTimersByTimeAsync(200);
		expect(h.host.read).toHaveBeenCalledTimes(reads + 1);
	});
	it("keeps a settled task selectable and restores its selection on reopen", async () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		h.tasks[0]!.status = "failed";
		h.tasks[0]!.endedAt = 1000;
		h.setOutput("build failure output");
		h.change();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("Finished");
		expect(h.frame()).toContain("build failure output");
		expect(h.state.selectedId).toBe("build");
		h.menu.dispose();
		expect(h.release).toHaveBeenCalledOnce();
		const reopened = harness(h.tasks, { state: h.state, width: 120 });
		expect(reopened.state.selectedId).toBe("build");
		expect(reopened.frame()).toContain("Failed");
	});
	it("locates all retained results and returns to the complete list", () => {
		const h = harness([
			backgroundTask("live"),
			backgroundTask("inline", { mode: "foreground", status: "completed", endedAt: 1 }),
			...Array.from({ length: 20 }, (_, i) => backgroundTask(`done-${i}`, { status: "completed", endedAt: i + 2 })),
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
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		expect(h.frame()).toContain("Finished");
		expect(h.state.selectedId).toBe("build");
		h.menu.handleInput("\x1b[B");
		expect(h.state.selectedId).toBe("check");
		expect(h.frame()).toContain("echo build");
	});
	it("lets configurable selected detach and confirmation act on only the selected task", () => {
		const h = harness(
			[backgroundTask("build", { mode: "foreground" }), backgroundTask("check", { mode: "foreground" })],
			{ width: 120 },
		);
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
		const h = harness([backgroundTask("build")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[H");
		expect(h.frame()).toContain("line-000");
		h.setOutput("final output");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.frame()).toContain("load final output");
		expect(h.frame()).not.toContain("\nfinal output");
		h.menu.handleInput("f");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("final output");
	});
	it("gives a narrow inspector twelve output lines and keeps metadata behind Details", async () => {
		const h = harness([backgroundTask("build", { cwd: "/project" })], { width: 72, height: 22 });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).not.toContain("line-079");
		h.menu.handleInput("\t");
		expect(h.frame().match(/line-\d+/g)?.length).toBeGreaterThanOrEqual(12);
		expect(h.frame()).not.toContain("/project");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("/project");
		h.menu.handleInput("\t");
		expect(h.frame()).not.toContain("/project");
		for (const line of h.menu.render(72)) expect(visibleWidth(line)).toBeLessThanOrEqual(72);
	});
	it("supports mouse selection, tab switching and wheel browsing", async () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
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
		const h = harness([backgroundTask("build")], { width: 120 });
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
		const h = harness([backgroundTask("build")], { width: 120 });
		h.setOutput("");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("No output yet");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("Completed with no output");
	});
	it("drops a selected task when it leaves the visible branch", () => {
		const h = harness([backgroundTask("old"), backgroundTask("new")], { width: 120 });
		h.tasks.shift();
		h.change();
		expect(h.frame()).not.toContain("echo old");
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledWith("new");
	});
});
