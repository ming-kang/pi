import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type BackgroundManagerHost,
	BackgroundTasksOverlay,
	type BackgroundTasksOverlayOptions,
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
	component: BackgroundTasksOverlay;
	tui: FakeTui;
	host: BackgroundManagerHost;
	keybindings: KeybindingsManager;
	sliceFor: Record<string, string>;
	killed: string[];
	onClose: ReturnType<typeof vi.fn>;
	render: () => string[];
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
		notified: false,
		...overrides,
	};
}

function createHarness(options?: {
	tasks?: BgTask[];
	sliceFor?: Record<string, string>;
	rows?: number;
	columns?: number;
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
	const componentOptions: BackgroundTasksOverlayOptions = {
		tui,
		theme: plainTheme,
		keybindings,
		host,
		onClose,
	};
	const component = new BackgroundTasksOverlay(componentOptions);
	return { component, tui, host, keybindings, sliceFor, killed, onClose, render: () => component.render(100) };
}

/** Raw terminal sequences accepted by matchesKey for the bindings the overlay uses. */
const RAW_KEYS: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
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

describe("BackgroundTasksOverlay", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders every row at the exact target width", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "line one\nline two\n" } });
		await vi.advanceTimersByTimeAsync(0);

		const lines = harness.render();
		expect(lines.length).toBeGreaterThan(6);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		expect(lines.some((line) => line.includes("bg-aaa111"))).toBe(true);
		expect(lines.some((line) => line.includes("line two"))).toBe(true);
	});

	it("moves the selection and resets follow state", async () => {
		const first = makeTask("bg-aaa111");
		const second = makeTask("bg-bbb222");
		const harness = createHarness({
			tasks: [first, second],
			sliceFor: { [first.outputPath]: "first out\n", [second.outputPath]: "second out\n" },
		});
		await vi.advanceTimersByTimeAsync(0);
		// Initial selection is the first task.
		expect(harness.render().some((line) => line.includes("first out"))).toBe(true);

		// Up wraps to the last task.
		harness.component.handleInput(rawKey("tui.select.up"));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.render().some((line) => line.includes("second out"))).toBe(true);

		harness.component.handleInput(rawKey("tui.select.down"));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.render().some((line) => line.includes("first out"))).toBe(true);
	});

	it("freezes the viewport on page-up and resumes following at the bottom", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: "" } });
		await vi.advanceTimersByTimeAsync(0);

		harness.sliceFor[task.outputPath] = "before\n";
		await vi.advanceTimersByTimeAsync(1000);
		expect(harness.render().some((line) => line.includes("before"))).toBe(true);

		harness.component.handleInput(rawKey("tui.select.pageUp"));
		harness.sliceFor[task.outputPath] = "before\nafter\n";
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

	it("kills only running tasks and shows feedback", async () => {
		const running = makeTask("bg-aaa111");
		const done = makeTask("bg-bbb222", "completed", { endedAt: 5000 });
		const harness = createHarness({ tasks: [running, done] });
		await vi.advanceTimersByTimeAsync(0);

		harness.component.handleInput("k");
		expect(harness.killed).toEqual([running.id]);
		expect(harness.render().some((line) => line.includes(`killed ${running.id}`))).toBe(true);

		// Move to the finished task; kill must be a no-op with feedback.
		harness.component.handleInput(rawKey("tui.select.down"));
		harness.component.handleInput("k");
		expect(harness.killed).toEqual([running.id]);
		expect(harness.render().some((line) => line.includes("is not running"))).toBe(true);
	});

	it("closes on cancel and clears the poll timer on dispose", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task] });
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		harness.component.handleInput(rawKey("tui.select.cancel"));
		expect(harness.onClose).toHaveBeenCalledTimes(1);

		harness.component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders ANSI output with sequences stripped and stays within width", async () => {
		const task = makeTask("bg-aaa111");
		const colored = "\x1b[31mred line\x1b[0m with trailing\n\x1b[0m";
		const harness = createHarness({ tasks: [task], sliceFor: { [task.outputPath]: colored } });
		await vi.advanceTimersByTimeAsync(0);

		const lines = harness.render();
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		const joined = lines.map((line) => stripTerminalSequences(line)).join("\n");
		expect(joined).toContain("red line with trailing");
	});

	it("survives a tiny terminal", async () => {
		const task = makeTask("bg-aaa111");
		const harness = createHarness({ tasks: [task], rows: 12, columns: 60 });
		await vi.advanceTimersByTimeAsync(0);

		const lines = harness.component.render(60);
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
		await vi.advanceTimersByTimeAsync(1000);

		const lines = harness.render();
		expect(lines.some((line) => line.includes("Cannot read output"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
	});
});
