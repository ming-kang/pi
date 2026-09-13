import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sliceText } from "../src/core/background/output.ts";
import { BackgroundService } from "../src/core/background/service.ts";
import type { BackgroundTask, BackgroundWorker } from "../src/core/background/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type BackgroundManagerHost, BackgroundTasksMenu } from "../src/extensions/background/manager.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const menus: BackgroundTasksMenu[] = [];
function task(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id,
		title: "build",
		kind: "bash",
		mode: "foreground",
		status: "running",
		startedAt: Date.now(),
		toolCallId: "call",
		anchorId: null,
		command: "npm run build",
		cwd: "/work",
		outputPath: "/tmp/build.log",
		...overrides,
	};
}
function worker(id: string, overrides: Partial<BackgroundWorker> = {}): BackgroundWorker {
	return {
		id,
		label: "#2 Explorer",
		status: "running",
		model: "model/thinking",
		usage: "1k tokens",
		prompt: "Inspect module",
		activity: "Read file.ts",
		profile: "explorer",
		description: "Inspect module",
		report: { text: "", truncated: false },
		...overrides,
	};
}
function harness(tasks = [task("bash-1")], width = 100, rows = 24, pollIntervalMs?: number) {
	let listener = () => {};
	let text = Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n");
	const releases: string[] = [];
	const pins: string[] = [];
	const unsubscribe = vi.fn();
	const host: BackgroundManagerHost = {
		list: () => [...tasks],
		read: vi.fn(async (id) => ({
			task: tasks.find((t) => t.id === id)!,
			text,
			totalBytes: text.length,
			truncated: false,
		})),
		kill: vi.fn((id) => {
			const t = tasks.find((t) => t.id === id)!;
			if (t.status !== "running" && t.status !== "queued") return false;
			t.status = "stopping";
			return true;
		}),
		subscribe: (fn) => {
			listener = fn;
			return unsubscribe;
		},
		pin: (id) => {
			pins.push(id);
			return () => {
				releases.push(id);
			};
		},
	};
	const tui = { requestRender: vi.fn(), terminal: { columns: width, rows } };
	const onClose = vi.fn();
	const keybindings = new KeybindingsManager();
	const menu = new BackgroundTasksMenu({ tui, host, theme, keybindings, onClose, pollIntervalMs });
	menus.push(menu);
	return {
		menu,
		host,
		tasks,
		tui,
		onClose,
		keybindings,
		pins,
		releases,
		unsubscribe,
		change: () => listener(),
		setText: (value: string) => {
			text = value;
		},
		render: () => menu.render(width).map(stripTerminalSequences),
		open: async () => {
			menu.handleInput("\r");
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}
describe("BackgroundTasksMenu public service", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Command highlighting and worker Markdown use the shared global theme.
		initTheme("dark");
	});
	afterEach(() => {
		for (const menu of menus.splice(0)) menu.dispose();
		vi.useRealTimers();
	});
	it.each([60, 140])("animates within a second without polling output more often at width %i", async (width) => {
		vi.setSystemTime(0);
		const h = harness([task("bash-1")], width);
		await vi.advanceTimersByTimeAsync(0);
		const frames: string[] = [];
		h.tui.requestRender.mockImplementation(() => {
			frames.push(h.render().join("\n"));
		});
		const reads = vi.mocked(h.host.read).mock.calls.length;
		const list = vi.spyOn(h.host, "list");
		await vi.advanceTimersByTimeAsync(480);
		expect(new Set(frames).size).toBeGreaterThanOrEqual(4);
		for (const frame of frames) expect(frame).toContain("running · foreground · 0s");
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		expect(list).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(520);
		expect(h.host.read).toHaveBeenCalledTimes(reads + (width >= 100 ? 1 : 0));
		expect(frames.at(-1)).toContain("running · foreground · 1s");
	});
	it("keeps animating while a selected output read is pending", async () => {
		vi.setSystemTime(0);
		const h = harness([task("bash-1")], 60);
		let resolve!: (value: Awaited<ReturnType<BackgroundManagerHost["read"]>>) => void;
		vi.mocked(h.host.read).mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await h.open();
		const frames: string[] = [];
		h.tui.requestRender.mockImplementation(() => {
			frames.push(h.render().join("\n"));
		});
		await vi.advanceTimersByTimeAsync(750);
		expect(new Set(frames).size).toBeGreaterThanOrEqual(4);
		expect(h.host.read).toHaveBeenCalledOnce();
		resolve({ task: h.tasks[0]!, text: "new output", totalBytes: 10, truncated: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(frames.at(-1)).toContain("new output");
	});
	it("starts animation for newly running workers and stops it when they settle", async () => {
		vi.setSystemTime(0);
		const activeWorker = worker("worker-1", { status: "queued" });
		const group = task("group-1", {
			kind: "subagent",
			status: "stopping",
			projection: { workers: [activeWorker] },
		});
		const h = harness([group], 140, 24, 60_000);
		await h.open();
		h.tui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(750);
		expect(h.tui.requestRender).not.toHaveBeenCalled();
		activeWorker.status = "running";
		h.change();
		h.change(); // repeated progress must not add animation timers
		const frames: string[] = [];
		h.tui.requestRender.mockImplementation(() => {
			frames.push(h.render().join("\n"));
		});
		await vi.advanceTimersByTimeAsync(750);
		expect(new Set(frames).size).toBeGreaterThanOrEqual(4);
		expect(frames.length).toBeLessThanOrEqual(7);
		activeWorker.status = "completed";
		group.status = "completed";
		group.endedAt = Date.now();
		h.change();
		await h.open();
		expect(h.render().join("\n")).toContain("✓ #2 Explorer");
		h.tui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(750);
		expect(h.tui.requestRender).not.toHaveBeenCalled();
		expect(h.host.read).not.toHaveBeenCalled();
	});
	it("does not read hidden output in a narrow list; drilldown and ordinary close never kill", async () => {
		const h = harness([task("bash-1")], 60);
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.host.read).not.toHaveBeenCalled();
		expect(h.render().join("\n")).toContain("foreground");
		await h.open();
		expect(h.render().join("\n")).toContain("line-40");
		h.menu.handleInput("\x1b");
		expect(h.onClose).not.toHaveBeenCalled();
		h.menu.handleInput("\x1b");
		expect(h.onClose).toHaveBeenCalledOnce();
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("shows list and selected detail simultaneously in wide terminals", async () => {
		const h = harness(undefined, 140);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("bash-1");
		expect(frame).toContain("npm run build");
		expect(frame).toContain("line-40");
		expect(frame).toContain("│");
		expect(frame).toContain("Output");
	});
	it("renders group and worker rows and worker projections, killing only the group after confirmation", async () => {
		const group = task("group-1", {
			kind: "subagent",
			command: undefined,
			projection: { workers: [worker(`subagent-${randomUUID()}-worker-2`)] },
		});
		const h = harness([group], 140);
		await vi.advanceTimersByTimeAsync(0);
		let frame = h.render().join("\n");
		expect(frame).toContain("Workers");
		expect(frame).toContain("#2 Explorer · running — Inspect module");
		h.menu.handleInput("\x1b[B");
		await vi.advanceTimersByTimeAsync(0);
		frame = h.render().join("\n");
		expect(
			h
				.render()
				.map((line) => line.split("│")[0] ?? "")
				.join("\n"),
		).toContain("#2 Explorer");
		for (const text of [
			"Explorer",
			"Prompt",
			"Inspect module",
			"Activity",
			"Read file.ts",
			"Outcome",
			"Still running",
			"1k tokens",
			"model/thinking",
		])
			expect(frame).toContain(text);
		h.menu.handleInput("k");
		expect(h.host.kill).not.toHaveBeenCalled();
		expect(h.render().join("\n")).toContain("Stop group-1 (whole group)? y/N");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledWith("group-1");
		expect(h.pins).toEqual(["group-1"]);
	});
	it("keeps group worker lines compact and wraps worker model and usage instead of truncating", async () => {
		const model = `provider/${"very-long-model-name-".repeat(4)} · high`;
		const group = task("group-1", {
			kind: "subagent",
			command: undefined,
			projection: {
				workers: [worker("worker-1", { model, usage: "123 tokens · $0.0001 · 2 tool calls" })],
			},
		});
		const h = harness([group], 140);
		await vi.advanceTimersByTimeAsync(0);
		let frame = h.render().join("\n");
		expect(frame).toContain("#2 Explorer · running — Inspect module");
		expect(frame).not.toContain("provider/");
		h.menu.handleInput("\x1b[B"); // select the worker row
		await vi.advanceTimersByTimeAsync(0);
		frame = h.render().join("\n");
		expect(frame).toContain("Model");
		expect(frame).toContain("Usage");
		expect(frame).toContain("· high"); // the wrapped tail survives instead of truncating
		expect(frame).toContain("123 tokens · $0.0001 · 2 tool calls");
	});
	it("preserves stable selected worker identity as statuses reorder groups", async () => {
		const first = task("first");
		const second = task("second", {
			kind: "subagent",
			command: undefined,
			projection: {
				workers: [
					worker("worker-7", {
						label: "General",
						prompt: "unique prompt",
						activity: "",
						model: undefined,
						usage: undefined,
					}),
				],
			},
		});
		const h = harness([first, second], 140);
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("\x1b[B");
		h.tasks.reverse();
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.render().join("\n")).toContain("unique prompt");
		expect(h.pins).toEqual(["first", "second"]);
		expect(h.releases).toEqual(["first"]);
	});
	it("retains selected final detail and stops reading and repainting settled tasks", async () => {
		const h = harness([task("bash-1")], 100, 24, 60_000);
		await h.open();
		expect(h.render().join("\n")).toContain("line-40");
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = Date.now();
		h.setText("final outcome");
		h.change();
		h.menu.handleInput("\x1b[C"); // queues a tick: the settled task gets one final read
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("final outcome");
		const reads = vi.mocked(h.host.read).mock.calls.length;
		h.setText("never read");
		h.change();
		h.menu.handleInput("\x1b[C"); // a forced tick never re-reads a settled task
		await vi.advanceTimersByTimeAsync(0);
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		expect(h.render().join("\n")).not.toContain("never read");
		const renders = h.tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000); // no poll tick inside the 60s interval, no repaint
		expect(h.tui.requestRender).toHaveBeenCalledTimes(renders);
		expect(h.onClose).not.toHaveBeenCalled();
	});
	it("reads only the selected visible output with a bounded budget", async () => {
		const h = harness([task("a"), task("b")], 140);
		await vi.advanceTimersByTimeAsync(2000);
		expect(vi.mocked(h.host.read).mock.calls.length).toBeGreaterThan(0);
		for (const [id, options] of vi.mocked(h.host.read).mock.calls) {
			expect(id).toBe("a");
			expect(options?.bytes).toBe(128 * 1024);
		}
	});
	it("preserves manual scroll position on output growth and follows again at the bottom", async () => {
		const h = harness([task("bash-1")], 140);
		await h.open();
		h.menu.handleInput("\x1b[A");
		let frame = h.render().join("\n");
		expect(frame).toContain("line-32");
		expect(frame).not.toContain("line-40");
		expect(frame).toContain("browsing");
		h.setText(`${Array.from({ length: 41 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n")}`);
		await vi.advanceTimersByTimeAsync(1000);
		frame = h.render().join("\n");
		expect(frame).toContain("line-32");
		expect(frame).not.toContain("line-41");
		h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		frame = h.render().join("\n");
		expect(frame).toContain("line-41");
		expect(frame).toContain("following");
	});
	it("clamps paging at the top and ignores extra scrolling beyond short content", async () => {
		const h = harness([task("bash-1")], 140);
		await h.open();
		for (let i = 0; i < 8; i++) h.menu.handleInput("\x1b[5~");
		expect(h.render().join("\n")).toContain("line-01");
		h.setText("one\ntwo");
		await vi.advanceTimersByTimeAsync(1000);
		for (let i = 0; i < 8; i++) h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\x1b[5~");
		const frame = h.render().join("\n");
		expect(frame).toContain("one");
		expect(frame).toContain("two");
	});
	it("holds a bounded browsing snapshot across rolling tails, row changes and settlement until following resumes", async () => {
		const h = harness([task("a", { mode: "background" }), task("b")], 140);
		const line = (index: number) => `line-${String(index).padStart(4, "0")} ${"x".repeat(50)}\n`;
		let log = Array.from({ length: 1500 }, (_, index) => line(index + 1)).join("");
		vi.mocked(h.host.read).mockImplementation(async (id, options) => ({
			task: h.tasks.find((task) => task.id === id)!,
			...sliceText(log, options),
		}));
		await vi.advanceTimersByTimeAsync(1000);
		await h.open();
		h.menu.handleInput("\x1b[5~");
		const visibleLines = () => h.render().flatMap((line) => line.match(/line-\d{4}/g) ?? []);
		const before = visibleLines();
		expect(before.length).toBeGreaterThan(0);
		log += Array.from({ length: 10 }, (_, index) => line(index + 1501)).join("");
		await vi.advanceTimersByTimeAsync(1000);
		expect(visibleLines()).toEqual(before);
		expect(h.render().join("\n")).toContain("browsing");

		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[B");
		await h.open();
		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[A");
		await h.open();
		expect(visibleLines()).toEqual(before);
		h.tasks[0]!.status = "failed";
		h.tasks[0]!.error = "Command exited with code 42";
		h.tasks[0]!.endedAt = Date.now();
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(visibleLines()[0]).toBe(before[0]);
		expect(h.render().join("\n")).toContain("Command exited with code 42");

		for (let i = 0; i < 2; i++) h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("following");
		expect(visibleLines()).toContain("line-1510");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("does not let a pending tail read replace the snapshot after the user starts browsing", async () => {
		const h = harness([task("bash-1")], 140);
		await h.open();
		let resolve!: (value: Awaited<ReturnType<BackgroundManagerHost["read"]>>) => void;
		vi.mocked(h.host.read).mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\x1b[5~");
		const visibleLines = () => h.render().filter((line) => line.includes("line-"));
		const before = visibleLines();
		resolve({ task: h.tasks[0]!, text: "new tail", totalBytes: 8, truncated: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(visibleLines()).toEqual(before);
		expect(h.render().join("\n")).not.toContain("new tail");
	});
	it("requires y confirmation before killing and gives honest stopping feedback", async () => {
		const h = harness();
		h.menu.handleInput("k");
		expect(h.host.kill).not.toHaveBeenCalled();
		expect(h.render().join("\n")).toContain("Stop bash-1 (whole group)? y/N");
		h.menu.handleInput("n");
		expect(h.host.kill).not.toHaveBeenCalled();
		expect(h.render().join("\n")).not.toContain("y/N");
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledWith("bash-1");
		expect(h.render().join("\n")).toContain("stopping bash-1… (whole group)");
		h.tasks[0]!.status = "completed";
		h.menu.handleInput("k");
		h.menu.handleInput("y");
		expect(h.render().join("\n")).toContain("no new cancellation requested");
		h.menu.handleInput("k");
		h.menu.handleInput("\x1b"); // any other input clears the confirmation without side effects
		expect(h.onClose).not.toHaveBeenCalled();
	});
	it("honors a rebound kill control", async () => {
		const h = harness();
		h.keybindings.setUserBindings({ "app.backgroundTasks.kill": "x" });
		h.menu.handleInput("k");
		expect(h.render().join("\n")).not.toContain("Stop bash-1");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("x");
		expect(h.render().join("\n")).toContain("Stop bash-1 (whole group)? y/N");
		h.menu.handleInput("y");
		expect(h.host.kill).toHaveBeenCalledWith("bash-1");
	});
	it("windows long lists and wraps selection", () => {
		const h = harness(
			Array.from({ length: 30 }, (_, i) => task(`task-${i}`, { command: `echo ${i}` })),
			100,
		);
		const initial = h.render().join("\n");
		expect(initial).toContain("30 running");
		expect(initial).toContain("echo 0");
		expect(initial).not.toContain("echo 29");
		h.menu.handleInput("\x1b[A");
		const frame = h.render().join("\n");
		expect(frame).toContain("echo 29");
		expect(frame).toMatch(/Task\s+task-29/);
		expect(frame).not.toContain("echo 0");
	});
	it.each([1, 2, 3, 20, 60, 100, 109, 110, 140])("fits ANSI and CJK output at width %i", async (width) => {
		const h = harness([task("wide", { title: "界".repeat(200), command: "界".repeat(200) })], width, 12);
		h.setText(`\x1b[31mred\x1b[0m\n${"界".repeat(200)}`);
		await h.open();
		for (const line of h.render()) expect(visibleWidth(line)).toBe(width);
	});
	it.each([100, 140])(
		"keeps actual missing-log and task errors visible while following a long fallback at width %i",
		async (width) => {
			vi.useRealTimers();
			const service = new BackgroundService({ enabled: true });
			try {
				await service.execute({
					kind: "bash",
					title: "missing log",
					toolCallId: "call",
					background: true,
					async run(control) {
						control.setOutputPath(join(process.cwd(), `missing-${randomUUID()}.log`));
						control.accept();
						return {
							status: "failed",
							error: "Command exited with code 42",
							result: {
								content: [{ type: "text", text: `${"fallback line\n".repeat(3000)}TAIL` }],
								details: undefined,
							},
						};
					},
				});
				await service.wait(service.list()[0]!.id);
				const read = await service.read(service.list()[0]!.id);
				expect(read.readError).toContain("ENOENT");
				const menu = new BackgroundTasksMenu({
					tui: { requestRender: vi.fn(), terminal: { columns: width, rows: 24 } },
					host: service,
					theme,
					keybindings: new KeybindingsManager(),
					onClose: vi.fn(),
				});
				menus.push(menu);
				menu.handleInput("\r");
				await vi.waitFor(() => {
					const frame = menu.render(width).map(stripTerminalSequences).join("\n");
					expect(frame).toContain("Command exited with code 42");
					expect(frame).toContain("Output read error:");
					expect(frame).toContain("fallback line");
				});
				menu.handleInput("\x1b[5~");
				expect(menu.render(width).map(stripTerminalSequences).join("\n")).toContain("Command exited with code 42");
				menu.dispose();
			} finally {
				await service.shutdown();
			}
		},
	);
	it("renders output read failures without rejecting UI work", async () => {
		const h = harness([task("bash-1")], 140);
		vi.mocked(h.host.read).mockRejectedValue(new Error("ENOENT"));
		await vi.advanceTimersByTimeAsync(0); // the in-flight first read settles
		await vi.advanceTimersByTimeAsync(1000); // the next tick's read rejects
		expect(h.render().join("\n")).toContain("Cannot read output");
	});
	it("disposes subscriptions, pin leases and timers; late reads cannot repaint", async () => {
		const h = harness([task("bash-1")], 60);
		let resolve!: (value: Awaited<ReturnType<BackgroundManagerHost["read"]>>) => void;
		vi.mocked(h.host.read).mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		h.menu.handleInput("\r");
		h.menu.dispose();
		const renders = h.tui.requestRender.mock.calls.length;
		resolve({ task: h.tasks[0]!, text: "late", totalBytes: 4, truncated: false });
		await vi.advanceTimersByTimeAsync(750);
		expect(h.tui.requestRender).toHaveBeenCalledTimes(renders);
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.releases).toEqual(["bash-1"]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([60, 140])(
		"routes arrows and pages to explicit focus at width %i without changing execution",
		async (width) => {
			const h = harness(
				Array.from({ length: 30 }, (_, i) => task(`task-${i}`, { command: `echo ${i}` })),
				width,
			);
			await vi.advanceTimersByTimeAsync(0);
			h.menu.handleInput("\x1b[6~");
			expect(h.render().join("\n")).toContain(width >= 100 ? "task-19" : "echo 7");
			h.menu.handleInput("\x1b[C");
			await vi.advanceTimersByTimeAsync(0);
			let frame = h.render().join("\n");
			expect(frame).toContain("· tail · following");
			h.menu.handleInput("\x1b[5~");
			frame = h.render().join("\n");
			expect(frame).toContain(width >= 100 ? "15–27/40" : "23–31/40");
			expect(frame).toContain("browsing");
			h.menu.handleInput("\x1b[D");
			h.menu.handleInput("\x1b[C");
			expect(h.render().join("\n")).toContain("browsing");
			h.menu.handleInput("\x1b");
			expect(h.onClose).not.toHaveBeenCalled();
			h.menu.handleInput("\x1b");
			expect(h.onClose).toHaveBeenCalledOnce();
			expect(h.host.kill).not.toHaveBeenCalled();
			expect(h.tasks.every((t) => t.mode === "foreground" && t.status === "running")).toBe(true);
		},
	);
	it("honors rebound focus, selection and independent list/preview page actions", async () => {
		const h = harness([task("alpha"), task("bravo")], 140);
		h.keybindings.setUserBindings({
			"app.backgroundTasks.focusList": "h",
			"app.backgroundTasks.focusPreview": "l",
			"tui.select.up": "u",
			"tui.select.down": "d",
			"tui.select.pageUp": "g",
			"tui.select.pageDown": "t",
			"tui.editor.pageUp": "p",
			"tui.editor.pageDown": "n",
		});
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\x1b[C"); // the old arrow binding no longer focuses the preview
		expect(h.render().join("\n")).toContain("L/Enter output");
		expect(h.render().join("\n")).toContain("G/T page");
		h.menu.handleInput("l");
		expect(h.render().join("\n")).toContain("P/N page");
		h.menu.handleInput("\x1b[5~"); // select.pageUp is not the preview page binding
		expect(h.render().join("\n")).toContain("following");
		h.menu.handleInput("g"); // list page binding does not scroll the preview
		expect(h.render().join("\n")).toContain("following");
		h.menu.handleInput("p");
		expect(h.render().join("\n")).toContain("browsing");
		h.menu.handleInput("n");
		expect(h.render().join("\n")).toContain("following");
		h.menu.handleInput("h");
		h.menu.handleInput("n"); // editor.pageDown ignored while the list is focused
		expect(h.render().join("\n")).toMatch(/Task\s+alpha/);
		h.menu.handleInput("t");
		expect(h.render().join("\n")).toMatch(/Task\s+bravo/);
		h.menu.handleInput("g");
		h.menu.handleInput("d");
		expect(h.render().join("\n")).toMatch(/Task\s+bravo/);
	});
	it("retains row snapshots and positions across selection, updates and resize", async () => {
		const h = harness([task("a"), task("b")], 140);
		await h.open();
		h.menu.handleInput("\x1b[5~");
		expect(h.render().join("\n")).toContain("15–27/40");
		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[B");
		await h.open();
		expect(h.render().join("\n")).toContain("28–40/40");
		expect(h.render().join("\n")).toContain("following");
		h.menu.handleInput("\x1b[A");
		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[A");
		await h.open();
		expect(h.render().join("\n")).toContain("15–27/40");
		expect(h.render().join("\n")).toContain("browsing");
		h.tui.terminal.rows = 30;
		expect(h.menu.render(60).map(stripTerminalSequences).join("\n")).toContain("15–33/40");
		h.tui.terminal.rows = 24;
		expect(h.menu.render(140).map(stripTerminalSequences).join("\n")).toContain("15–27/40");
		h.setText("short");
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.render().join("\n")).toContain("15–27/40");
		h.setText(Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.render().join("\n")).toContain("15–27/40");
		expect(h.render().join("\n")).toContain("browsing");
		h.menu.handleInput("\x1b[6~");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("38–50/50");
		expect(h.render().join("\n")).toContain("following");
	});
	it("keeps a wrapped source-line anchor when resizing a browsed preview", async () => {
		const h = harness(undefined, 140);
		h.setText(Array.from({ length: 40 }, (_, i) => `entry-${i}: ${"界".repeat(60)}`).join("\n"));
		await h.open();
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\x1b[5~");
		const before = h
			.render()
			.filter((line) => line.includes("entry-"))[0]!
			.match(/entry-\d+/)![0];
		expect(h.menu.render(60).map(stripTerminalSequences).join("\n")).toContain(before);
		expect(h.menu.render(140).map(stripTerminalSequences).join("\n")).toContain(before);
		expect(h.render().join("\n")).toContain("browsing");
	});
	it("captures deterministic wide and narrow rendered frames", async () => {
		vi.setSystemTime(0);
		const h = harness(undefined, 140);
		await vi.advanceTimersByTimeAsync(0);
		const wideList = h.render().join("\n");
		h.menu.handleInput("\x1b[C");
		h.menu.handleInput("\x1b[5~");
		const widePreview = h.render().join("\n");
		const narrowPreview = h.menu.render(60).map(stripTerminalSequences).join("\n");
		h.menu.handleInput("\x1b[D");
		const narrowList = h.menu.render(60).map(stripTerminalSequences).join("\n");
		expect({ wideList, widePreview, narrowPreview, narrowList }).toMatchInlineSnapshot(`
			{
			  "narrowList": "────────────────────────────────────────────────────────────
			Background tasks                                   1 running
			Running                                                     
			→ · npm run build                                    fg · 0s
			Status    · running · foreground · 0s                       
			Command   npm run build                                     
			─ Output · tail · browsing ────────────────────── 15–28/40 ─
			line-15                                                     
			line-16                                                     
			line-17                                                     
			line-18                                                     
			line-19                                                     
			line-20                                                     
			line-21                                                     
			line-22                                                     
			line-23                                                     
			line-24                                                     
			line-25                                                     
			line-26                                                     
			line-27                                                     
			line-28                                                     
			────────────────────────────────────────────────────────────
			↑/↓ select · ← list · →/Enter output · PgUp/PgDn page · K s…
			────────────────────────────────────────────────────────────",
			  "narrowPreview": "────────────────────────────────────────────────────────────
			Background tasks                                   1 running
			Running                                                     
			→ · npm run build                                    fg · 0s
			Status    · running · foreground · 0s                       
			Command   npm run build                                     
			─ Output · tail · browsing ────────────────────── 15–28/40 ─
			line-15                                                     
			line-16                                                     
			line-17                                                     
			line-18                                                     
			line-19                                                     
			line-20                                                     
			line-21                                                     
			line-22                                                     
			line-23                                                     
			line-24                                                     
			line-25                                                     
			line-26                                                     
			line-27                                                     
			line-28                                                     
			────────────────────────────────────────────────────────────
			↑/↓ select · ← list · →/Enter output · PgUp/PgDn page · K s…
			────────────────────────────────────────────────────────────",
			  "wideList": "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
			Background tasks                                                                                                                   1 running
			Running                                     │Status    · running · foreground · 0s                                                          
			→ · npm run build                    fg · 0s│Task      bash-1                                                                               
			                                            │Command   npm run build                                                                        
			                                            │Directory /work                                                                                
			                                            │Output    /tmp/build.log                                                                       
			                                            │─ Output · tail · following ──────────────────────────────────────────────────────── 28–40/40 ─
			                                            │line-28                                                                                        
			                                            │line-29                                                                                        
			                                            │line-30                                                                                        
			                                            │line-31                                                                                        
			                                            │line-32                                                                                        
			                                            │line-33                                                                                        
			                                            │line-34                                                                                        
			                                            │line-35                                                                                        
			                                            │line-36                                                                                        
			                                            │line-37                                                                                        
			                                            │line-38                                                                                        
			                                            │line-39                                                                                        
			                                            │line-40                                                                                        
			────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
			↑/↓ select · ← list · →/Enter output · PgUp/PgDn page · K stop · Esc close                                                                  
			────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
			  "widePreview": "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
			Background tasks                                                                                                                   1 running
			Running                                     │Status    · running · foreground · 0s                                                          
			→ · npm run build                    fg · 0s│Task      bash-1                                                                               
			                                            │Command   npm run build                                                                        
			                                            │Directory /work                                                                                
			                                            │Output    /tmp/build.log                                                                       
			                                            │─ Output · tail · browsing ───────────────────────────────────────────────────────── 15–27/40 ─
			                                            │line-15                                                                                        
			                                            │line-16                                                                                        
			                                            │line-17                                                                                        
			                                            │line-18                                                                                        
			                                            │line-19                                                                                        
			                                            │line-20                                                                                        
			                                            │line-21                                                                                        
			                                            │line-22                                                                                        
			                                            │line-23                                                                                        
			                                            │line-24                                                                                        
			                                            │line-25                                                                                        
			                                            │line-26                                                                                        
			                                            │line-27                                                                                        
			────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
			↑/↓ select · ← list · →/Enter output · PgUp/PgDn page · K stop · Esc close                                                                  
			────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
			}
		`);
	});
	it("uses semantic focus cues and never uses a selection background", async () => {
		const fg = vi.spyOn(theme, "fg");
		const bg = vi.spyOn(theme, "bg");
		try {
			const h = harness(undefined, 140);
			await vi.advanceTimersByTimeAsync(0);
			h.render();
			expect(fg).toHaveBeenCalledWith("accent", "Background tasks");
			expect(fg).toHaveBeenCalledWith("accent", "→ ");
			expect(fg).toHaveBeenCalledWith("muted", "Output");
			fg.mockClear();
			bg.mockClear();
			h.menu.handleInput("\x1b[C");
			h.render();
			expect(fg).toHaveBeenCalledWith("accent", "Output");
			expect(fg).toHaveBeenCalledWith("muted", "→ ");
			expect(bg).not.toHaveBeenCalled();
		} finally {
			fg.mockRestore();
			bg.mockRestore();
		}
	});
	it("scrolls long worker content from the top without shell follow labels", async () => {
		const h = harness(
			[
				task("group", {
					kind: "subagent",
					command: undefined,
					projection: {
						workers: [
							worker("long-worker-id", {
								label: "#1 Explorer",
								prompt: Array.from({ length: 40 }, (_, i) => `prompt-${i}`).join("\n"),
								activity: "activity",
								description: "Long task",
								report: { text: "outcome", truncated: false },
							}),
						],
					},
				}),
			],
			140,
		);
		h.menu.handleInput("\x1b[B");
		await h.open();
		expect(h.host.read).not.toHaveBeenCalled();
		const initial = h.render().join("\n");
		expect(initial).toContain("prompt-0");
		expect(initial).toMatch(/1–\d+\/\d+/);
		expect(initial).not.toMatch(/paused|following|browsing|long-worker-id/);
		h.menu.handleInput("\x1b[6~");
		expect(h.render().join("\n")).not.toContain("prompt-0");
		h.change();
		h.menu.handleInput("\x1b[D");
		h.menu.handleInput("\x1b[C");
		const frame = h.render().join("\n");
		expect(frame).toContain("14–26/47"); // the browsed position is retained across focus changes
		expect(frame).toContain("prompt-12");
		expect(frame).not.toContain("prompt-0");
	});
	it("orders running newest-first above finished and never selects section headers", () => {
		vi.setSystemTime(1_000_000);
		const now = Date.now();
		const h = harness(
			[
				task("done-old", {
					command: "cmd-done-old",
					mode: "background",
					status: "completed",
					startedAt: now - 5000,
					endedAt: now - 4000,
				}),
				task("old-run", { command: "cmd-old-run", startedAt: now - 1000 }),
				task("done-new", {
					command: "cmd-done-new",
					mode: "background",
					status: "failed",
					startedAt: now - 3000,
					endedAt: now - 2000,
				}),
				task("new-run", { command: "cmd-new-run", startedAt: now - 100 }),
			],
			140,
		);
		const frame = h.render().join("\n");
		let at = -1;
		for (const marker of ["Running", "cmd-new-run", "cmd-old-run", "Finished", "cmd-done-new", "cmd-done-old"]) {
			const index = frame.indexOf(marker);
			expect(index).toBeGreaterThan(at);
			at = index;
		}
		expect(frame).toContain("2 running · 1 completed · 1 failed");
		expect(frame).toContain("4s ago");
		expect(frame).toContain("2s ago");
		expect(frame).toMatch(/Task\s+new-run/);
		h.menu.handleInput("\x1b[A"); // wraps to the last selectable row, never a header
		expect(h.render().join("\n")).toMatch(/Task\s+done-old/);
		h.menu.handleInput("\x1b[B");
		expect(h.render().join("\n")).toMatch(/Task\s+new-run/);
		h.menu.handleInput("\x1b[B");
		h.menu.handleInput("\x1b[B"); // the Finished header is skipped implicitly
		expect(h.render().join("\n")).toMatch(/Task\s+done-new/);
	});
	it("stacks list, compressed detail and output in narrow terminals", async () => {
		const h = harness(undefined, 60);
		await h.open();
		const frame = h.render().join("\n");
		expect(frame).toContain("Running");
		expect(frame).toContain("npm run build");
		expect(frame).toContain("Output");
		expect(frame).toContain("line-40");
		expect(frame).not.toContain("│");
	});
	it("renders an empty state without task statistics", async () => {
		const h = harness([], 140);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("No background tasks.");
		expect(frame).not.toContain("running ·");
		h.menu.handleInput("k");
		expect(h.render().join("\n")).not.toContain("y/N");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("omits settled foreground shells from Finished and tags running foreground rows", async () => {
		vi.setSystemTime(1_000_000);
		const now = Date.now();
		const h = harness(
			[
				task("fg-run", { command: "cmd-fg-run", startedAt: now - 100 }),
				task("fg-done", {
					command: "cmd-fg-done",
					status: "completed",
					startedAt: now - 3000,
					endedAt: now - 2000,
				}),
				task("bg-done", {
					command: "cmd-bg-done",
					mode: "background",
					status: "completed",
					startedAt: now - 3000,
					endedAt: now - 2000,
				}),
			],
			140,
		);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("cmd-fg-run");
		expect(frame).toContain("fg · 0s");
		expect(frame).toContain("cmd-bg-done");
		expect(frame).not.toContain("cmd-fg-done");
		expect(frame).toContain("1 running · 1 completed · 1 foreground shell hidden");
	});
	it("reports hidden settled foreground shells in the empty state", async () => {
		const h = harness([task("fg-done", { status: "completed", endedAt: Date.now() })], 140);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("No background tasks.");
		expect(frame).toContain("1 foreground shell hidden");
		expect(frame).not.toContain("running ·");
	});
	it("keeps a selected settled foreground row until the selection moves away", async () => {
		const h = harness([task("bash-1"), task("bash-2", { command: "echo second" })], 140);
		await vi.advanceTimersByTimeAsync(0);
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = Date.now();
		h.change();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("1 running · 1 completed");
		h.menu.handleInput("\x1b[B"); // move to bash-2: bash-1 is no longer watched
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).not.toContain("npm run build");
		expect(frame).toContain("1 running · 1 foreground shell hidden");
	});
	it.each([60, 140])("shows completed foreground subagents when opening the panel at width %s", async (width) => {
		const group = task("subagent-fg", {
			kind: "subagent",
			title: "Subagent group",
			command: undefined,
			status: "completed",
			endedAt: Date.now(),
			projection: {
				workers: [
					worker("worker-1", { status: "completed", report: { text: "Saved worker report", truncated: false } }),
				],
			},
		});
		const tasks = [task("bash-live"), group];
		const h = harness(tasks, width, 32);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("1 running · 1 completed");
		expect(h.render().join("\n")).toContain("#2 Explorer");
		h.menu.handleInput("\x1b[B");
		expect(h.render().join("\n")).toContain("fg · 1/1 · 0s ago");
		h.menu.handleInput("\x1b[B");
		await h.open();
		expect(h.render().join("\n")).toContain("Saved worker report");
		h.menu.dispose();
		const reopened = harness(tasks, width, 32);
		await vi.advanceTimersByTimeAsync(0);
		expect(reopened.render().join("\n")).toContain("#2 Explorer");
		expect(group.mode).toBe("foreground");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("keeps a foreground subagent in Finished after settlement and selection moves away", async () => {
		const group = task("subagent-fg", {
			kind: "subagent",
			title: "Subagent group",
			command: undefined,
			projection: { workers: [worker("worker-1")] },
		});
		const h = harness([group, task("bash-live")], 140);
		h.menu.handleInput("\x1b[B");
		group.status = "completed";
		group.endedAt = Date.now();
		group.projection!.workers![0]!.status = "completed";
		group.projection!.workers![0]!.report.text = "Finished while watched";
		h.change();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("Finished while watched");
		h.menu.handleInput("\x1b[A");
		h.menu.handleInput("\x1b[A");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toMatch(/Task\s+bash-live/);
		expect(h.render().join("\n")).toContain("1 running · 1 completed");
		expect(h.render().join("\n")).toContain("#2 Explorer");
		expect(h.render().join("\n")).not.toContain("foreground shells hidden");
	});
	it("shows the worker description in its list row", async () => {
		const group = task("group-1", {
			kind: "subagent",
			mode: "background",
			command: undefined,
			projection: { workers: [worker("worker-1")] },
		});
		const h = harness([group]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("#2 Explorer — Inspect module");
	});
	it("shows settled/total progress on subagent group rows", async () => {
		const group = task("group-1", {
			kind: "subagent",
			mode: "background",
			command: undefined,
			projection: {
				workers: [
					worker("worker-1", { status: "completed" }),
					worker("worker-2", { status: "running" }),
					worker("worker-3", { status: "queued" }),
				],
			},
		});
		const h = harness([group], 140);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("1/3 ·");
	});
	it("shows the exit code in the bash detail status line", async () => {
		const h = harness([
			task("bash-done", { mode: "background", status: "completed", endedAt: Date.now(), exitCode: 0 }),
		]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.render().join("\n")).toContain("completed · background · 0s ago · exit 0");
	});

	it("splits header counts into completed and failed, hiding zero segments", async () => {
		const h = harness([
			task("bg-run", { mode: "background", status: "running" }),
			task("bg-ok", { mode: "background", status: "completed", endedAt: Date.now() }),
			task("bg-fail", { mode: "background", status: "failed", endedAt: Date.now() }),
			task("bg-cancel", { mode: "background", status: "cancelled", endedAt: Date.now() }),
		]);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("1 running");
		expect(frame).toContain("1 completed");
		expect(frame).toContain("2 failed");
		expect(frame).not.toContain("finished");
	});
	it("auto-cancels a pending kill confirmation after the timeout", async () => {
		const h = harness([task("bash-1")]);
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("k");
		expect(h.render().join("\n")).toContain("Stop bash-1 (whole group)? y/N");
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.render().join("\n")).not.toContain("Stop bash-1");
		h.menu.handleInput("y");
		expect(h.host.kill).not.toHaveBeenCalled();
	});
	it("renders a resize notice instead of the layout in a tiny terminal", async () => {
		const h = harness([task("bash-1")], 50, 8);
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(frame).toContain("Terminal too small for /bg");
		expect(frame).toContain("close");
		expect(frame).not.toContain("npm run build");
	});
});
