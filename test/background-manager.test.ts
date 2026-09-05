import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundService } from "../src/core/background/service.ts";
import type { BackgroundTask } from "../src/core/background/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type BackgroundManagerHost, BackgroundTasksMenu } from "../src/extensions/background/manager.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as unknown as Theme;
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
function harness(tasks = [task("bash-1")], width = 100, rows = 24) {
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
	const menu = new BackgroundTasksMenu({ tui, host, theme, keybindings, onClose });
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
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		for (const menu of menus.splice(0)) menu.dispose();
		vi.useRealTimers();
	});
	it("does not read hidden output in a narrow list; drilldown and ordinary close never kill", async () => {
		const h = harness();
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
		expect(frame).toContain("line-40");
		expect(frame).toContain("│");
	});
	it("renders group and worker rows and worker projections, killing only the group", async () => {
		const group = task("group-1", {
			kind: "subagent",
			projection: {
				workers: [
					{
						id: `subagent-${randomUUID()}-worker-2`,
						label: "#2 Explorer",
						status: "running",
						model: "model/thinking",
						usage: "1k tokens",
						prompt: "Inspect module",
						activity: "Read file.ts",
						outcome: "",
					},
				],
			},
		});
		const h = harness([group], 140);
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\x1b[B");
		await vi.advanceTimersByTimeAsync(0);
		const frame = h.render().join("\n");
		expect(
			h
				.render()
				.map((line) => line.split("│")[0])
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
		expect(h.host.kill).toHaveBeenCalledWith("group-1");
		expect(h.pins).toEqual(["group-1"]);
	});
	it("preserves stable selected worker identity as statuses reorder groups", async () => {
		const first = task("first");
		const second = task("second", {
			kind: "subagent",
			projection: {
				workers: [
					{
						id: "worker-7",
						label: "General",
						status: "running",
						prompt: "unique prompt",
						activity: "",
						outcome: "",
					},
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
	it("retains selected final detail and stops reading/redrawing settled tasks", async () => {
		const h = harness();
		await h.open();
		h.tasks[0]!.status = "completed";
		h.tasks[0]!.endedAt = Date.now();
		h.setText("final outcome");
		h.change();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.render().join("\n")).toContain("final outcome");
		const reads = vi.mocked(h.host.read).mock.calls.length;
		const renders = h.tui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(h.host.read).toHaveBeenCalledTimes(reads);
		expect(h.tui.requestRender).toHaveBeenCalledTimes(renders);
		expect(h.onClose).not.toHaveBeenCalled();
	});
	it("reads only the selected visible output with a bounded budget", async () => {
		const h = harness([task("a"), task("b")], 140);
		await vi.advanceTimersByTimeAsync(2000);
		for (const [id, options] of vi.mocked(h.host.read).mock.calls) {
			expect(id).toBe("a");
			expect(options?.bytes).toBe(128 * 1024);
		}
	});
	it("preserves manual scroll position on output growth and follows again at the bottom", async () => {
		const h = harness();
		await h.open();
		h.menu.handleInput("\x1b[A");
		const before = h.render().join("\n");
		expect(before).toContain("line-25");
		expect(before).not.toContain("line-40");
		h.setText(`${Array.from({ length: 41 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n")}`);
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.render().join("\n")).toContain("line-25");
		h.menu.handleInput("\x1b[6~");
		expect(h.render().join("\n")).toContain("line-41");
	});
	it("clamps paging at the top and ignores extra scrolling beyond short content", async () => {
		const h = harness();
		await h.open();
		for (let i = 0; i < 8; i++) h.menu.handleInput("\x1b[5~");
		expect(h.render().join("\n")).toContain("line-01");
		h.setText("one\ntwo");
		await vi.advanceTimersByTimeAsync(1000);
		h.menu.handleInput("\x1b[5~");
		expect(h.render().join("\n")).toContain("two");
	});
	it("uses configurable controls and gives honest stopping feedback", async () => {
		const h = harness();
		h.keybindings.setUserBindings({ "app.backgroundTasks.kill": "x" });
		h.menu.handleInput("k");
		expect(h.host.kill).not.toHaveBeenCalled();
		h.menu.handleInput("x");
		expect(h.render().join("\n")).toContain("stopping bash-1");
		h.tasks[0]!.status = "completed";
		h.menu.handleInput("x");
		expect(h.render().join("\n")).toContain("no new cancellation");
	});
	it("windows long lists and wraps selection", () => {
		const h = harness(Array.from({ length: 30 }, (_, i) => task(`task-${i}`)));
		expect(h.render().join("\n")).toContain("(1/30)");
		expect(h.render().join("\n")).not.toContain("task-29");
		h.menu.handleInput("\x1b[A");
		expect(h.render().join("\n")).toContain("(30/30)");
		expect(h.render().join("\n")).toContain("task-29");
	});
	it.each([1, 20, 60, 100, 140])("fits ANSI and CJK output at width %i", async (width) => {
		const h = harness([task("wide", { title: "界".repeat(200) })], width, 12);
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
				expect(menu.render(width).join("\n")).toContain("Command exited with code 42");
				menu.dispose();
			} finally {
				await service.shutdown();
			}
		},
	);
	it("renders output read failures without rejecting UI work", async () => {
		const h = harness();
		vi.mocked(h.host.read).mockRejectedValue(new Error("ENOENT"));
		await h.open();
		expect(h.render().join("\n")).toContain("Cannot read output");
	});
	it("disposes subscriptions, pin leases and timers; late reads cannot repaint", async () => {
		const h = harness();
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
		await vi.advanceTimersByTimeAsync(0);
		expect(h.tui.requestRender).toHaveBeenCalledTimes(renders);
		expect(h.unsubscribe).toHaveBeenCalledOnce();
		expect(h.releases).toEqual(["bash-1"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
