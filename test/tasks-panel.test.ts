import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { TasksMenu } from "../src/extensions/tasks/ui/manager.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { backgroundTask, disposeMenus, harness, mouse, task } from "./fixtures/tasks-panel-harness.ts";

describe("task panel views", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		initTheme("dark");
	});
	afterEach(() => {
		disposeMenus();
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
	it("shows published output for a log without a managed file without polling reads", async () => {
		const h = harness([
			task("one", { outputPath: undefined, result: { text: "published output", truncated: false } }),
		]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.host.read).not.toHaveBeenCalled();
		expect(h.frame()).toContain("published output");
		h.tasks[0]!.result = { text: "updated output", truncated: false };
		h.change();
		expect(h.frame()).toContain("updated output");
		expect(h.host.read).not.toHaveBeenCalled();
	});
	it("reads a terminal file-less log once for its expiry diagnostic without polling", async () => {
		const h = harness([
			task("one", {
				outputPath: undefined,
				status: "completed",
				endedAt: 1000,
				result: { text: "saved output", truncated: false },
			}),
		]);
		h.host.read.mockImplementationOnce(async () => ({
			task: h.tasks[0]!,
			text: "saved output",
			readError: "Output has expired",
			totalBytes: 12,
			truncated: false,
		}));
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.host.read).toHaveBeenCalledOnce();
		expect(h.frame()).toContain("Log unavailable; showing saved result.");
		expect(h.frame()).toContain("saved output");
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
		const h = harness([
			task("review", { kind: "review", label: "Review", input: undefined, title: "Inspect boundaries" }),
		]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.left()).toContain("Inspect boundaries");
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("Review");
		expect(h.frame()).toContain("Title     Inspect boundaries");
	});
	it("renders executor-owned Details separately from published Output", async () => {
		const h = harness([
			task("agent-test", {
				kind: "agent",
				label: "Agent",
				output: "report",
				outputPath: undefined,
				display: { text: "✓ read src/index.ts · 2ms", truncated: false },
				title: "Inspect boundaries",
				input: { label: "Prompt", text: "Inspect boundaries\nwith a second line", truncated: false },
				facts: [
					["Model", "test/model"],
					["Thinking", "high"],
				],
			}),
		]);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.frame()).toContain("✓ read");
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("Model     test/model");
		expect(h.frame()).toContain("Thinking  high");
		expect(h.frame()).toContain("Prompt");
		expect(h.frame()).not.toContain("Title     Inspect boundaries");
	});

	const report = (overrides: Partial<TaskSnapshot> = {}) =>
		task("agent-markdown", {
			kind: "agent",
			label: "Agent",
			output: "report",
			input: { label: "Prompt", text: "Inspect Markdown", truncated: false },
			title: "Inspect Markdown",
			status: "completed",
			endedAt: 1000,
			// Report tasks have no log; Output renders the published result directly.
			outputPath: undefined,
			result: { text: "## Report\n\n**Bold** and `src/index.ts`.\n\n- first item", truncated: false },
			...overrides,
		});
	it("renders a completed Agent report as Markdown", () => {
		const h = harness([report()]);
		expect(h.frame()).toContain("Report");
		expect(h.frame()).toContain("Bold and src/index.ts.");
		expect(h.frame()).toContain("- first item");
		expect(h.frame()).not.toContain("## Report");
		expect(h.frame()).not.toContain("**Bold**");
		expect(h.frame()).not.toContain("`src/index.ts`");
		expect(h.menu.render(140).join("\n")).toContain(theme.fg("mdCode", "src/index.ts"));
		expect(h.host.read).not.toHaveBeenCalled();
	});
	describe("settled reports", () => {
		const paragraphs = (count: number, prefix = "paragraph") =>
			Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`).join("\n\n");
		const tall = (overrides: Partial<TaskSnapshot> = {}) =>
			report({ result: { text: paragraphs(60), truncated: false }, ...overrides });
		const bottom = (h: ReturnType<typeof harness>) => h.frame().split("\n").at(-2)!;

		it.each([
			["wide", { width: 120, height: 30 }, false],
			["narrow", { width: 80, height: 26 }, true],
		])("opens a report taller than the pane at its first line in the %s layout", async (_name, size, open) => {
			const h = harness([tall()], size);
			if (open) h.menu.handleInput("\r");
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.frame()).toContain("paragraph-00");
			expect(h.frame()).not.toContain("paragraph-59");
			// Reopening the panel starts over at the top, too.
			h.menu.dispose();
			const reopened = harness([tall()], size);
			if (open) reopened.menu.handleInput("\r");
			expect(reopened.frame()).toContain("paragraph-00");
		});

		it("shows a followed running report from its first line once it settles", async () => {
			const running = report({
				status: "running",
				endedAt: undefined,
				result: { text: "Agent running · 60 tool calls", truncated: false },
				display: {
					text: Array.from({ length: 60 }, (_, i) => `✓ read file-${i}.ts · 1ms`).join("\n"),
					truncated: false,
				},
			});
			const h = harness([running], { width: 120 });
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.frame()).toContain("file-59.ts");
			expect(h.frame()).not.toContain("file-0.ts");
			Object.assign(h.tasks[0]!, tall(), { id: "agent-markdown", display: undefined });
			h.change();
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.frame()).toContain("paragraph-00");
			expect(h.frame()).not.toContain("paragraph-59");
		});

		it("keeps the position of a settled report the user scrolled", async () => {
			const h = harness([tall()], { width: 120 });
			h.menu.handleInput("\t");
			h.menu.handleInput("\x1b[6~");
			const scrolled = h.frame();
			expect(scrolled).not.toContain("paragraph-00");
			expect(scrolled).not.toContain("paragraph-59");
			h.change();
			await vi.advanceTimersByTimeAsync(2000);
			h.tasks[0]!.result = { text: paragraphs(60), truncated: false };
			h.change();
			expect(h.frame()).toBe(scrolled);
			expect(bottom(h)).not.toMatch(/ 1–/);
		});

		it("renders the published report, never the attached file, and has no reading state", async () => {
			const h = harness(
				[tall({ outputPath: "/tmp/agent-full.md", result: { text: paragraphs(4), truncated: true } })],
				{
					width: 120,
				},
			);
			h.setOutput("FILE-TAIL");
			await vi.advanceTimersByTimeAsync(2000);
			h.menu.handleInput("\t");
			h.menu.handleInput("f");
			await vi.advanceTimersByTimeAsync(2000);
			expect(h.host.read).not.toHaveBeenCalled();
			expect(h.frame()).toContain("paragraph-03");
			expect(h.frame()).not.toContain("FILE-TAIL");
			expect(h.frame()).not.toMatch(/Browsing|Tail preview|load final output/);
			expect(bottom(h)).not.toMatch(/Finished|Live/);
			expect(h.menu.render(120).join("\n")).not.toContain("follow");
			h.menu.handleInput("\x1b[C");
			expect(h.frame()).toMatch(/Full report\s+\/tmp\/agent-full\.md/);
			expect(h.frame()).not.toMatch(/Log\s+\/tmp/);
		});

		it("shows a report path once when a Details fact already names it", async () => {
			const h = harness(
				[
					tall({
						outputPath: "/tmp/agent-full.md",
						facts: [["Report", "/tmp/agent-full.md"]],
						result: { text: paragraphs(4), truncated: true },
					}),
				],
				{ width: 120 },
			);
			await vi.advanceTimersByTimeAsync(2000);
			h.menu.handleInput("\t");
			h.menu.handleInput("f");
			await vi.advanceTimersByTimeAsync(2000);
			h.menu.handleInput("\x1b[C");
			expect(h.frame()).toMatch(/Report\s+\/tmp\/agent-full\.md/);
			expect(h.frame()).not.toContain("Full report");
			expect(h.frame().match(/agent-full\.md/g)).toHaveLength(1);
		});

		it("shows the scroll range of an overflowing report in the bottom border", () => {
			const h = harness([tall()], { width: 120 });
			expect(bottom(h)).toMatch(/ 1–\d+\/\d+ ─┘$/);
			const short = harness([report()], { width: 120 });
			expect(bottom(short)).not.toMatch(/\d+–\d+\/\d+/);
		});
	});

	it("shows the executor's display instead of the model-facing result", () => {
		const h = harness([
			report({
				status: "running",
				endedAt: undefined,
				result: { text: "Agent running · 1 tool call · latest: read src/index.ts", truncated: false },
				display: { text: "Tool calls\n✓ read src/index.ts · 2ms", truncated: false },
			}),
		]);
		expect(h.frame()).toContain("Tool calls");
		expect(h.frame()).toContain("✓ read src/index.ts · 2ms");
		expect(h.frame()).not.toContain("Agent running");
		expect(h.frame()).not.toContain("latest:");
	});
	it("follows whichever text it shows when announcing truncation", () => {
		const shown = harness([
			report({
				display: { text: "Tool calls", truncated: true },
				result: { text: "report", truncated: true },
			}),
		]);
		expect(shown.frame()).toContain("Output truncated.");
		expect(shown.frame()).not.toContain("Saved result truncated.");
		const result = harness([report({ result: { text: "report", truncated: true } })]);
		expect(result.frame()).toContain("Saved result truncated.");
	});

	it("shows a published result as soon as it changes, without waiting for a poll", () => {
		const h = harness([
			task("agent-live", {
				kind: "agent",
				label: "Agent",
				output: "report",
				outputPath: undefined,
				result: { text: "Agent running; no tool calls yet.", truncated: false },
			}),
		]);
		expect(h.frame()).toContain("Agent running; no tool calls yet.");
		h.tasks[0]!.result = { text: "Agent running · 1 tool call · latest: read a.ts", truncated: false };
		h.change();
		expect(h.frame()).toContain("latest: read a.ts");
	});

	it("puts each task on one row with its source, title and runtime", () => {
		const h = harness([task("build", { startedAt: 0 }), task("deploy", { kind: "agent", label: "Agent" })]);
		const row = h
			.left()
			.split("\n")
			.find((line) => line.includes("echo build"))!;
		expect(row).toMatch(/Bash\s+echo build\s+1s/);
		expect(h.left()).toMatch(/Agent\s+echo deploy/);
	});

	it("puts the tabs in the inspector's top border and the task and its meta line in its first rows", () => {
		const h = harness([task("build"), task("done", { status: "cancelled", endedAt: 500 })], { width: 120 });
		const rows = () => h.frame().split("\n");
		expect(rows()[0]).toMatch(/┌─ Tasks · 1 active · 1 finished .*┐ ┌─ Output {2}Details ─+┐$/);
		expect(rows()[1]!.split("│")[3]).toMatch(/^echo build\s*$/);
		expect(rows()[2]!.split("│")[3]).toMatch(/^Bash · Running · Foreground · 1s\s*$/);
		h.menu.handleInput("\x1b[B");
		expect(rows()[2]!.split("│")[3]).toMatch(/^Bash · Cancelled · Foreground · 1s\s*$/);
	});

	it("colors the meta status by its outcome", () => {
		const h = harness([task("done", { status: "failed", endedAt: 500 })], { width: 120 });
		expect(h.menu.render(120)[2]).toContain(theme.fg("error", "Failed"));
	});

	it("shows the selected task's full title beside a list that truncates it", () => {
		const title = "deploy the staging environment with the canary rollout";
		const h = harness([task("deploy", { title, input: undefined })], { width: 120 });
		expect(h.left()).toContain("…");
		expect(h.left()).not.toContain(title);
		expect(h.frame().split("\n")[1]!.split("│")[3]).toContain(title);
	});

	it.each([
		[100, 40],
		[120, 48],
		[150, 60],
		[220, 60],
	])("gives the list 40 percent of a split terminal, between 34 and 60 columns (width %i)", (width, list) => {
		const h = harness([task("build")], { width });
		const top = h.frame().split("\n")[0]!;
		expect(top.indexOf("┐") + 1).toBe(list);
		expect(top.indexOf("┌", 1)).toBe(list + 1);
		expect(visibleWidth(top)).toBe(width);
	});

	it("shows the list and the inspector one at a time below 100 columns", () => {
		const h = harness([task("build")], { width: 99 });
		expect(h.frame().split("\n")[0]!.match(/┌/g)).toHaveLength(1);
		expect(h.frame()).toContain("Tasks");
		expect(h.frame()).not.toContain("Output");
		h.menu.handleInput("\r");
		expect(h.frame()).toContain("Output");
		expect(h.frame().split("\n")[1]).toContain("echo build");
	});

	it("starts Details with the task ID, then the input, with no source or status rows", () => {
		const h = harness([task("build")]);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		const frame = h.frame();
		const row = (label: string) => frame.indexOf(`${label}  `);
		expect(row("Task ID")).toBeGreaterThan(-1);
		expect(row("Task ID")).toBeLessThan(row("Command"));
		expect(row("Source")).toBe(-1);
		expect(row("Status")).toBe(-1);
	});

	it("shows a multi-line input as a block after the facts", () => {
		const h = harness([
			task("script", {
				input: { label: "Script", text: "echo one\necho two", truncated: false },
				facts: [["Directory", "/project"]],
			}),
		]);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		const frame = h.frame();
		expect(frame.indexOf("Task ID")).toBeLessThan(frame.indexOf("Directory"));
		expect(frame.indexOf("Directory")).toBeLessThan(frame.indexOf("Script"));
		expect(frame.indexOf("Script")).toBeLessThan(frame.indexOf("echo two"));
	});

	it("scrolls long information independently and honors rebound controls", async () => {
		const command = Array.from({ length: 50 }, (_, i) => `echo parameter-${i}`).join("\n");
		const h = harness([
			task("custom", {
				kind: "custom",
				title: "parameters",
				input: { label: "Script", text: command, truncated: false },
			}),
		]);
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
		expect(h.frame()).not.toContain('Stop Bash "');
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
		expect(h.frame()).toContain('Stop Bash "echo first"?');
		// The list stays visible behind the footer question.
		expect(h.left()).toContain("echo second");
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.frame()).toContain('Stop Bash "echo first"?');
		expect(h.frame().split("\n").at(-1)).toMatch(/Enter stop\s+Esc cancel$/);
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
		expect(h.state.selectedId).toBe("task-25");
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
		disposeMenus();
		vi.useRealTimers();
	});
	it("keeps task selection visible when the terminal cannot report background colors", () => {
		initTheme("system");
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		const selected = () => h.menu.render(120).find((line) => /Bash\s+echo build/.test(stripTerminalSequences(line)))!;
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
		expect(h.frame()).toContain("Stop Bash");
	});
	it("switches only two panes and preserves the right tab, with border-only focus", async () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		const before = h.menu.render(120);
		h.menu.handleInput("\x1b[C");
		h.menu.handleInput("f");
		expect(h.menu.render(120)).toEqual(before);
		h.menu.handleInput("\t");
		const after = h.menu.render(120);
		const row = h.listRow("echo build");
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
	it("makes footer hints clickable", () => {
		const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
		const hints = h.frame().split("\n").at(-1)!;
		h.menu.handleMouse(mouse(hints.indexOf("stop"), 29));
		expect(h.frame()).toContain('Stop Bash "echo build"?');
		h.menu.handleMouse(mouse(hints.indexOf("Esc close") + 1, 29));
		expect(h.frame()).not.toContain("Stop Bash");
		h.menu.handleMouse(mouse(hints.indexOf("Esc close") + 1, 29));
		expect(h.close).toHaveBeenCalledOnce();
	});
	it("advertises background only while the host can move the task, and still explains a refusal", () => {
		const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
		expect(h.frame().split("\n").at(-1)).toContain("background");
		h.host.canDetach.mockReturnValue(false);
		h.host.detach.mockImplementation(() => {
			throw new Error("Background task limit reached (2).");
		});
		expect(h.frame().split("\n").at(-1)).not.toContain("background");
		h.menu.handleInput("b");
		expect(h.frame().split("\n").at(-1)).toContain("Background task limit reached");
	});
	it("dismisses stop when its target finishes without stopping the next selection", () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		h.menu.handleInput("k");
		h.tasks[0]!.status = "completed";
		h.change();
		expect(h.frame()).not.toContain('Stop Bash "');
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
		h.menu.handleMouse(mouse(5, h.listRow("echo check")));
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
		const row = () => h.listRow("echo task-15");
		const before = row();
		expect(before).toBeGreaterThan(0);
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
	it("lets the row and header show a granted stop, without a notice", () => {
		const h = harness([backgroundTask("build")], { width: 120 });
		h.menu.handleInput("k");
		h.menu.handleInput("\r");
		expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
		expect(h.frame().split("\n").at(-1)).not.toMatch(/[!×]/);
		h.tasks[0]!.status = "stopping";
		h.change();
		expect(h.frame().split("\n")[2]).toContain("Stopping");
		h.tasks[0]!.status = "cancelled";
		h.tasks[0]!.endedAt = 1000;
		h.change();
		expect(h.frame()).toContain("Cancelled");
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
	it("selects work started since the panel last closed when reopened", () => {
		const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
		h.menu.handleInput("\x1b[B");
		h.menu.dispose();
		h.tasks.push(backgroundTask("deploy", { startedAt: 1500 }));
		const reopened = harness(h.tasks, { state: h.state, width: 120 });
		expect(reopened.state.selectedId).toBe("deploy");
	});
	it("opens the selected task with Enter, including in a narrow terminal", async () => {
		const h = harness([backgroundTask("build", { facts: [["Directory", "/project"]] })], { width: 72, height: 22 });
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleInput("\r");
		expect(h.frame().match(/line-\d+/g)?.length).toBeGreaterThanOrEqual(12);
		h.menu.handleInput("\x1b[C");
		expect(h.frame()).toContain("/project");
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
		const h = harness([backgroundTask("build", { facts: [["Directory", "/project"]] })], { width: 72, height: 22 });
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
		h.menu.handleMouse(mouse(5, h.listRow("echo check")));
		expect(h.state.selectedId).toBe("check");
		await vi.advanceTimersByTimeAsync(0);
		const lines = h.frame().split("\n");
		const row = lines.findIndex((line) => line.includes("Details"));
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

describe("task panel with a real runtime", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => disposeMenus());

	it("shows a running task's published display from a real runtime", async () => {
		const runtime = new TaskRuntime({ enabled: true });
		const finish = Promise.withResolvers<{ result: { content: []; details: undefined } }>();
		const outcome = await runtime.execute({
			kind: "agent",
			label: "Agent",
			title: "Live display",
			output: "report",
			toolCallId: "call",
			background: true,
			run: (control) => {
				control.accept();
				control.publish({
					result: { content: [{ type: "text", text: "model status" }], details: undefined },
					display: "published display",
				});
				return finish.promise;
			},
		});
		expect(outcome.kind).toBe("background");
		const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
		const menu = new TasksMenu({
			host: runtime,
			tui,
			theme,
			keybindings: new KeybindingsManager(),
			onClose: vi.fn(),
		});
		try {
			const frame = menu.render(120).map(stripTerminalSequences).join("\n");
			expect(frame).toContain("published display");
		} finally {
			menu.dispose();
			finish.resolve({ result: { content: [], details: undefined } });
			runtime.close();
		}
	});
});
