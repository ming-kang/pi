import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type BackgroundManagerHost,
	BackgroundTasksMenu,
	type BackgroundTasksMenuOptions,
} from "../src/extensions/background/manager.ts";
import type { BgTask } from "../src/extensions/background/registry.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

// Theme stub: pass styling through untouched so width assertions see plain text.
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface FakeTui {
	requestRender: ReturnType<typeof vi.fn<() => void>>;
	terminal: { rows: number; columns: number };
}

interface Harness {
	component: BackgroundTasksMenu;
	tui: FakeTui;
	host: BackgroundManagerHost;
	keybindings: KeybindingsManager;
	sliceFor: Record<string, string>;
	killed: string[];
	onClose: ReturnType<typeof vi.fn>;
	render: () => string[];
	enterDetail: () => Promise<void>;
}

function makeTask(id: string, status: BgTask["status"] = "running", overrides?: Partial<BgTask>): BgTask {
	// Align with the faked clock so durations read 0s instead of epoch gaps.
	const startedAt = Date.now();
	return {
		id,
		command: "npm run dev",
		cwd: "/work",
		status,
		startedAt,
		exitCode: status === "running" ? undefined : 0,
		outputPath: `/tmp/pi-${id}.log`,
		outputBytes: 64,
		outputTruncated: false,
		stalled: false,
		notified: false,
		...overrides,
	};
}

function createHarness(options?: {
	tasks?: BgTask[];
	sliceFor?: Record<string, string>;
	rows?: number;
	columns?: number;
	width?: number;
}): Harness {
	const keybindings = new KeybindingsManager();
	const tui: FakeTui = {
		requestRender: vi.fn<() => void>(),
		terminal: { rows: options?.rows ?? 24, columns: options?.columns ?? 100 },
	};
	const killed: string[] = [];
	const sliceFor: Record<string, string> = options?.sliceFor ?? {};
	const host: BackgroundManagerHost = {
		listTasks: () => [...(options?.tasks ?? [])],
		killTask: (id) => {
			killed.push(id);
			return { killed: true };
		},
		readSlice: async (filePath, _sliceOptions) => ({
			text: sliceFor[filePath] ?? "",
			sliceBytes: (sliceFor[filePath] ?? "").length,
			totalBytes: (sliceFor[filePath] ?? "").length,
			truncated: false,
			startsMidLine: false,
		}),
	};
	const onClose = vi.fn<() => void>();
	const componentOptions: BackgroundTasksMenuOptions = {
		tui,
		theme: plainTheme,
		keybindings,
		host,
		onClose,
	};
	const component = new BackgroundTasksMenu(componentOptions);
	const width = options?.width ?? 100;
	return {
		component,
		tui,
		host,
		keybindings,
		sliceFor,
		killed,
		onClose,
		render: () => component.render(width),
		enterDetail: async () => {
			component.handleInput(rawKey("tui.select.confirm"));
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

/** Raw terminal sequences accepted by matchesKey for the bindings the menu uses. */
const RAW_KEYS: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
	"tui.select.cancel": "\x1b",
	"app.backgroundTasks.kill": "k",
};

function rawKey(binding: string): string {
	const key = RAW_KEYS[binding];
	if (key === undefined) throw new Error(`no raw key for ${binding}`);
	return key;
}

describe("BackgroundTasksMenu", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the list view at the exact width with task rows and hints", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "hidden output\n" } });
		await vi.advanceTimersByTimeAsync(0);

		const lines = harness.render();
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		expect(lines.some((line) => line.includes("bg-aaa111"))).toBe(true);
		expect(lines.some((line) => line.includes("select"))).toBe(true);
		// The list view never shows task output.
		expect(lines.some((line) => line.includes("hidden output"))).toBe(false);
	});

	it("marks stalled tasks in the list and detail header", async () => {
		const task = makeTask("bg-aaa111", "running", { stalled: true });
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "Proceed? (y/n)\n" } });
		await vi.advanceTimersByTimeAsync(0);

		const listLines = harness.render();
		expect(listLines.some((line) => line.includes("…"))).toBe(true);

		await harness.enterDetail();
		const detailLines = harness.render();
		expect(detailLines.some((line) => line.includes("waiting for input"))).toBe(true);
	});

	it("opens the output view on enter and steps back on cancel", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "line one\nline two\n" } });
		await vi.advanceTimersByTimeAsync(0);

		await harness.enterDetail();
		let lines = harness.render();
		expect(lines.some((line) => line.includes("line two"))).toBe(true);
		expect(lines.some((line) => line.includes("scroll"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}

		// First cancel returns to the list without closing.
		harness.component.handleInput(rawKey("tui.select.cancel"));
		lines = harness.render();
		expect(harness.onClose).not.toHaveBeenCalled();
		expect(lines.some((line) => line.includes("line two"))).toBe(false);
		expect(lines.some((line) => line.includes("select"))).toBe(true);

		// Second cancel closes the menu.
		harness.component.handleInput(rawKey("tui.select.cancel"));
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it("moves the selection with wrap-around and opens the selected task", async () => {
		const first = makeTask("bg-aaa111");
		const second = makeTask("bg-bbb222");
		const harness = createHarness({
			tasks: [first, second],
			sliceFor: { [first.outputPath]: "first out\n", [second.outputPath]: "second out\n" },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.render().some((line) => line.includes("→") && line.includes("bg-aaa111"))).toBe(true);

		// Up wraps to the last task.
		harness.component.handleInput(rawKey("tui.select.up"));
		expect(harness.render().some((line) => line.includes("→") && line.includes("bg-bbb222"))).toBe(true);

		await harness.enterDetail();
		expect(harness.render().some((line) => line.includes("second out"))).toBe(true);
	});

	it("freezes the viewport on page-up and resumes following at the bottom", async () => {
		const task = makeTask("bg-aaa111");
		const before = Array.from({ length: 30 }, (_, i) => `before-${i + 1}`).join("\n");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${before}\n` } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();
		expect(harness.render().some((line) => line.includes("before-30"))).toBe(true);

		harness.component.handleInput(rawKey("tui.select.pageUp"));
		harness.sliceFor[task.outputPath] = `${before}\nafter\n`;
		await vi.advanceTimersByTimeAsync(1000);
		// Frozen: the newly appended line must not appear while paused.
		expect(harness.render().some((line) => line.includes("after"))).toBe(false);
		expect(harness.render().some((line) => line.includes("paused"))).toBe(true);

		// Paging back down to the bottom resumes following and refreshes.
		harness.component.handleInput(rawKey("tui.select.pageDown"));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.render().some((line) => line.includes("after"))).toBe(true);
		expect(harness.render().some((line) => line.includes("paused"))).toBe(false);
	});

	it("clamps page-up at the top of the buffer", async () => {
		const task = makeTask("bg-aaa111");
		const content = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${content}\n` } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		for (let i = 0; i < 5; i++) {
			harness.component.handleInput(rawKey("tui.select.pageUp"));
		}
		// Over-scrolling stops at the top instead of running into blank space.
		const lines = harness.render();
		expect(lines.some((line) => line.includes("line-1"))).toBe(true);
	});

	it("ignores page-up when the output fits the viewport", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "one\ntwo\n" } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		harness.component.handleInput(rawKey("tui.select.pageUp"));
		const lines = harness.render();
		expect(lines.some((line) => line.includes("paused"))).toBe(false);
		expect(lines.some((line) => line.includes("two"))).toBe(true);
	});

	it("omits the resume hint when pageDown is unbound", async () => {
		const task = makeTask("bg-aaa111");
		const content = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${content}\n` } });
		harness.keybindings.setUserBindings({ "tui.select.pageDown": [] });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		// Frozen via the raw sequence so unbinding pageDown does not block scrolling.
		harness.component.handleInput("\x1b[5~");
		const lines = harness.render();
		expect(lines.some((line) => line.includes("paused"))).toBe(true);
		expect(lines.some((line) => line.includes("( to follow)"))).toBe(false);
		expect(lines.some((line) => line.includes("to follow"))).toBe(false);
	});

	it("kills only running tasks and shows feedback", async () => {
		const running = makeTask("bg-aaa111");
		const done = makeTask("bg-bbb222", "completed", { endedAt: 5000 });
		const harness = createHarness({ tasks: [running, done] });
		await vi.advanceTimersByTimeAsync(0);

		harness.component.handleInput("k");
		expect(harness.killed).toEqual([running.id]);
		expect(harness.render().some((line) => line.includes(`stopping ${running.id}…`))).toBe(true);

		// "stopping" feedback expires once the task settles (next poll sees the terminal status).
		const settling = makeTask("bg-ccc333");
		const expiring = createHarness({ tasks: [settling] });
		await vi.advanceTimersByTimeAsync(0);
		expiring.component.handleInput("k");
		expect(expiring.render().some((line) => line.includes("stopping bg-ccc333…"))).toBe(true);
		settling.status = "killed";
		settling.endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(1000);
		expect(expiring.render().some((line) => line.includes("stopping"))).toBe(false);

		// Move to the finished task; kill must be a no-op with feedback.
		harness.component.handleInput(rawKey("tui.select.down"));
		harness.component.handleInput("k");
		expect(harness.killed).toEqual([running.id]);
		expect(harness.render().some((line) => line.includes("is not running"))).toBe(true);
	});

	it("clears the poll timer on dispose", async () => {
		const harness = createHarness({ tasks: [makeTask("bg-aaa111")] });
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		harness.component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders ANSI output with sequences stripped and stays within width", async () => {
		const task = makeTask("bg-aaa111");
		const colored = "\x1b[31mred line\x1b[0m with trailing\n\x1b[0m";
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: colored } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		const lines = harness.render();
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		const joined = lines.map((line) => stripTerminalSequences(line)).join("\n");
		expect(joined).toContain("red line with trailing");
	});

	it("keeps every row at the exact width with wide CJK content", async () => {
		const task = makeTask("bg-aaa111", "running", {
			command: "构建整个项目并运行全部端到端测试用例然后部署到预发布环境 && 再次构建整个项目并运行全部测试",
		});
		const cjkLine = "第一阶段：正在编译所有模块，请耐心等待，输出行会超过视口宽度以验证等宽填充逻辑。".repeat(2);
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${cjkLine}\n完成\n` } });
		await vi.advanceTimersByTimeAsync(0);

		// List view: the selected row (padded before styling) and every other row.
		for (const line of harness.render()) {
			expect(visibleWidth(line)).toBe(100);
		}

		await harness.enterDetail();
		const lines = harness.render();
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		expect(lines.some((line) => line.includes("完成"))).toBe(true);
	});

	it("windows the task list beyond ten entries with a position indicator", async () => {
		const tasks = Array.from({ length: 12 }, (_, i) => makeTask(`bg-t${String(i + 1).padStart(2, "0")}xx`));
		const harness = createHarness({ tasks });
		await vi.advanceTimersByTimeAsync(0);

		let lines = harness.render();
		expect(lines.some((line) => line.includes("(1/12)"))).toBe(true);
		expect(lines.some((line) => line.includes("bg-t01xx"))).toBe(true);
		expect(lines.some((line) => line.includes("bg-t12xx"))).toBe(false);

		// Up wraps to the last task and scrolls the window.
		harness.component.handleInput(rawKey("tui.select.up"));
		lines = harness.render();
		expect(lines.some((line) => line.includes("(12/12)"))).toBe(true);
		expect(lines.some((line) => line.includes("bg-t12xx"))).toBe(true);
		expect(lines.some((line) => line.includes("bg-t01xx"))).toBe(false);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
	});

	it("survives a tiny terminal in both views", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], rows: 12, columns: 60, width: 60 });
		await vi.advanceTimersByTimeAsync(0);

		for (const line of harness.render()) {
			expect(visibleWidth(line)).toBe(60);
		}
		await harness.enterDetail();
		const lines = harness.render();
		expect(lines.length).toBeGreaterThan(4);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	it("shows a read error instead of crashing", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task] });
		harness.host.readSlice = async () => {
			throw new Error("ENOENT: no such file");
		};
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		const lines = harness.render();
		expect(lines.some((line) => line.includes("Cannot read output"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
	});

	it("stops redrawing entirely once every task has settled", async () => {
		const task = makeTask("bg-aaa111", "completed", { endedAt: Date.now(), exitCode: 0 });
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "done\n" } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();
		await vi.advanceTimersByTimeAsync(1000); // Stabilize: the post-enter tick lands.

		const rendersBefore = harness.tui.requestRender.mock.calls.length;
		let reads = 0;
		const originalRead = harness.host.readSlice;
		harness.host.readSlice = async (filePath, options) => {
			reads += 1;
			return originalRead(filePath, options);
		};

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(reads).toBe(0);
		expect(harness.tui.requestRender.mock.calls.length).toBe(rendersBefore);
	});

	it("re-reads a running task's output only when it actually grew", async () => {
		const content = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
		const task = makeTask("bg-aaa111", "running", { outputBytes: content.length + 1 });
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${content}\n` } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();
		await vi.advanceTimersByTimeAsync(1000); // Stabilize: one read has landed.

		let reads = 0;
		const originalRead = harness.host.readSlice;
		harness.host.readSlice = async (filePath, options) => {
			reads += 1;
			return originalRead(filePath, options);
		};

		// Idle ticks: the duration keeps the UI live, but the file is not touched.
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(reads).toBe(0);

		// Output grows: exactly one re-read on the next poll, new line visible.
		harness.sliceFor[task.outputPath] = `${content}\nextra line\n`;
		task.outputBytes += "extra line\n".length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(reads).toBe(1);
		expect(harness.render().some((line) => line.includes("extra line"))).toBe(true);
	});

	it("separates finished tasks from running ones in the list", async () => {
		const harness = createHarness({
			tasks: [
				makeTask("bg-aaa111"),
				makeTask("bg-bbb222"),
				makeTask("bg-ccc333", "completed", { endedAt: Date.now(), exitCode: 0 }),
			],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.render().some((line) => line.includes("── finished ──"))).toBe(true);

		// No boundary, no separator — and never for an empty finished group.
		const onlyRunning = createHarness({ tasks: [makeTask("bg-aaa111")] });
		await vi.advanceTimersByTimeAsync(0);
		expect(onlyRunning.render().some((line) => line.includes("── finished ──"))).toBe(false);
	});

	it("narrows the visible list rows on short terminals", async () => {
		const tasks = Array.from({ length: 5 }, (_, i) =>
			makeTask(`bg-s${i}00aa`, "completed", { endedAt: Date.now(), exitCode: 0 }),
		);
		const harness = createHarness({ tasks, rows: 16 });
		await vi.advanceTimersByTimeAsync(0);

		const lines = harness.render();
		expect(lines.filter((line) => line.includes("bg-s")).length).toBe(3);
		expect(lines.some((line) => line.includes("(1/5)"))).toBe(true);
	});

	it("scrolls the output view one line at a time with up/down", async () => {
		const task = makeTask("bg-aaa111", "completed", { endedAt: Date.now(), exitCode: 0 });
		const content = Array.from({ length: 30 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: `${content}\n` } });
		await vi.advanceTimersByTimeAsync(0);
		await harness.enterDetail();

		// Following shows the bottom 16 lines: 15–30.
		let lines = harness.render();
		expect(lines.some((line) => line.includes("line-15"))).toBe(true);
		expect(lines.some((line) => line.includes("line-14"))).toBe(false);

		harness.component.handleInput(rawKey("tui.select.up"));
		lines = harness.render();
		expect(lines.some((line) => line.includes("paused"))).toBe(true);
		expect(lines.some((line) => line.includes("line-14"))).toBe(true);
		expect(lines.some((line) => line.includes("line-30"))).toBe(false);

		harness.component.handleInput(rawKey("tui.select.down"));
		lines = harness.render();
		expect(lines.some((line) => line.includes("paused"))).toBe(false);
		expect(lines.some((line) => line.includes("line-30"))).toBe(true);
	});
});
