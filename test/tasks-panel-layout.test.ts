import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { backgroundTask, disposeMenus, harness, mouse, task } from "./fixtures/tasks-panel-harness.ts";

describe("task panel navigation, notices and targets", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		initTheme("dark");
	});
	afterEach(() => {
		disposeMenus();
		vi.useRealTimers();
	});
	const footer = (h: ReturnType<typeof harness>) => h.frame().split("\n").at(-1)!;

	it("goes back from the inspector to the list on Escape in a narrow terminal, then closes", () => {
		const h = harness([backgroundTask("build")], { width: 72, height: 22 });
		expect(footer(h)).toMatch(/Esc close$/);
		h.menu.handleInput("\r");
		expect(footer(h)).toMatch(/Esc back$/);
		expect(h.frame()).toContain("Output");
		h.menu.handleInput("\x1b");
		expect(h.close).not.toHaveBeenCalled();
		expect(h.frame()).toContain("Active");
		expect(footer(h)).toMatch(/Esc close$/);
		h.menu.handleInput("\x1b");
		expect(h.close).toHaveBeenCalledOnce();
	});

	it("unwinds search, help and confirmation before going back from a narrow inspector", () => {
		const h = harness([backgroundTask("build")], { width: 72, height: 22 });
		h.menu.handleInput("\r");
		h.menu.handleInput("?");
		h.menu.handleInput("\x1b");
		expect(h.frame()).toContain("Output");
		h.menu.handleInput("k");
		expect(footer(h)).toContain("Stop Bash");
		h.menu.handleInput("\x1b");
		expect(h.frame()).toContain("Output");
		h.menu.handleInput("/");
		h.menu.handleInput("\x1b");
		// Cancelling the search restores the inspector focus it started from.
		expect(h.frame()).toContain("Output");
		expect(footer(h)).toMatch(/Esc back$/);
		expect(h.close).not.toHaveBeenCalled();
	});

	it("closes on Escape from either pane in a wide terminal", () => {
		const first = harness([backgroundTask("build")], { width: 120 });
		expect(footer(first)).toMatch(/Esc close$/);
		first.menu.handleInput("\x1b");
		expect(first.close).toHaveBeenCalledOnce();
		const second = harness([backgroundTask("build")], { width: 120 });
		second.menu.handleInput("\t");
		expect(footer(second)).toMatch(/Esc close$/);
		second.menu.handleInput("\x1b");
		expect(second.close).toHaveBeenCalledOnce();
	});

	it("closes straight from the resize notice", () => {
		const h = harness([backgroundTask("build")], { width: 50, height: 20 });
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b");
		expect(h.close).toHaveBeenCalledOnce();
	});

	it("drops the lowest-priority hints first on narrow footers and keeps the Escape action", () => {
		const wide = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
		expect(footer(wide)).toMatch(
			/^↑ \/ ↓ tasks · Enter open · \/ find · k stop · b background · \? keys\s+Esc close$/,
		);
		const narrow = harness([backgroundTask("build", { mode: "foreground" })], { width: 62, height: 20 });
		const line = footer(narrow);
		expect(visibleWidth(line)).toBe(62);
		expect(line).toMatch(/Esc close$/);
		expect(line).toContain("? keys");
		expect(line).toContain("k stop");
		expect(line).not.toContain("↑ / ↓");
	});

	describe("feedback", () => {
		it("shows a refusal as a warning that clears after four seconds", async () => {
			const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
			h.host.detach.mockReturnValue(false);
			h.menu.handleInput("b");
			expect(footer(h)).toMatch(/^! This task cannot move to background\.\s+Esc close$/);
			expect(h.menu.render(120).at(-1)).toContain(theme.fg("warning", "! This task cannot move to background."));
			h.tui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(3900);
			expect(footer(h)).toContain("! This task");
			await vi.advanceTimersByTimeAsync(200);
			expect(footer(h)).toContain("k stop");
			expect(footer(h)).not.toContain("!");
			expect(h.tui.requestRender).toHaveBeenCalled();
		});

		it("clears on the next key or click", () => {
			const h = harness([backgroundTask("build", { mode: "foreground" }), backgroundTask("check")], { width: 120 });
			h.host.detach.mockReturnValue(false);
			h.menu.handleInput("b");
			expect(footer(h)).toContain("! This task");
			h.menu.handleInput("\x1b[B");
			expect(footer(h)).not.toContain("! This task");
			h.menu.handleInput("\x1b[A");
			h.menu.handleInput("b");
			expect(footer(h)).toContain("! This task");
			h.menu.handleMouse(mouse(60, 10));
			expect(footer(h)).not.toContain("! This task");
		});

		it("reports an unexpected failure as an error", () => {
			const h = harness([backgroundTask("build")], { width: 120 });
			h.host.kill.mockImplementation(() => {
				throw new Error("kill failed");
			});
			h.menu.handleInput("k");
			h.menu.handleInput("\r");
			expect(footer(h)).toMatch(/^× kill failed/);
			expect(h.menu.render(120).at(-1)).toContain(theme.fg("error", "× kill failed"));
		});

		it("keeps a message that does not fit beside the Escape hint, truncated only at the edge", () => {
			const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 72, height: 22 });
			h.host.detach.mockImplementation(() => {
				throw new Error("Background task limit reached (2); wait for one to finish or stop one first.");
			});
			h.menu.handleInput("b");
			const line = footer(h);
			expect(line).toContain("! Background task limit reached (2); wait for one to finish or");
			expect(visibleWidth(line)).toBe(72);
		});

		it("says nothing when a stop or background request succeeds", () => {
			const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
			h.menu.handleInput("b");
			expect(h.host.detach).toHaveBeenCalledExactlyOnceWith("build");
			expect(footer(h)).not.toMatch(/[!×]/);
			h.menu.handleInput("k");
			h.menu.handleInput("\r");
			expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
			expect(footer(h)).not.toMatch(/[!×]/);
			expect(footer(h)).toContain("? keys");
		});

		it("explains a refused cancellation and requests that change nothing", () => {
			const h = harness(
				[
					backgroundTask("running"),
					backgroundTask("stopping", { status: "stopping" }),
					backgroundTask("done", { status: "completed", endedAt: 1 }),
				],
				{ width: 120 },
			);
			h.host.kill.mockReturnValue(false);
			h.menu.handleInput("k");
			h.menu.handleInput("\r");
			expect(footer(h)).toContain("! No new cancellation requested.");
			h.menu.handleInput("\x1b[B");
			h.menu.handleInput("k");
			expect(footer(h)).toContain("! Task is already stopping.");
			h.menu.handleInput("\x1b[B");
			h.menu.handleInput("b");
			expect(footer(h)).toContain("! Task already finished.");
			h.menu.handleInput("\x1b[A");
			h.menu.handleInput("\x1b[A");
			h.menu.handleInput("b");
			expect(footer(h)).toContain("! Task is already in the background.");
			expect(h.host.detach).not.toHaveBeenCalled();
		});

		it("releases its timer when the panel closes", () => {
			const h = harness([backgroundTask("build", { mode: "foreground" })], { width: 120 });
			h.host.detach.mockReturnValue(false);
			h.menu.handleInput("b");
			h.menu.dispose();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("stop confirmation target", () => {
		it("marks the target row while the question is open and nowhere else", () => {
			const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
			const row = (text: string) => h.frame().split("\n")[h.listRow(text)]!;
			expect(row("echo build")).not.toContain("stop?");
			h.menu.handleInput("k");
			expect(row("echo build")).toMatch(/stop\? · 1s/);
			expect(row("echo check")).not.toContain("stop?");
			expect(h.menu.render(120)[h.listRow("echo build")]).toContain(theme.fg("warning", "stop?"));
			h.menu.handleInput("\x1b");
			expect(row("echo build")).not.toContain("stop?");
		});
	});

	describe("tab hit boxes", () => {
		it.each([100, 120, 150])("cover exactly the rendered tab labels at width %i", (width) => {
			const h = harness([backgroundTask("build")], { width });
			const top = h.frame().split("\n")[0]!;
			const output = top.indexOf("Output");
			const details = top.indexOf("Details");
			const click = (x: number) => h.menu.handleMouse(mouse(x, 0, { width }));
			click(details + "Details".length - 1);
			expect(h.state.tab).toBe("info");
			click(output + "Output".length);
			expect(h.state.tab).toBe("info");
			click(output);
			expect(h.state.tab).toBe("output");
			click(details - 1);
			expect(h.state.tab).toBe("output");
			click(details);
			expect(h.state.tab).toBe("info");
		});

		it("follow the labels in a narrow inspector too", () => {
			const h = harness([backgroundTask("build")], { width: 72, height: 22 });
			h.menu.handleInput("\r");
			const top = h.frame().split("\n")[0]!;
			h.menu.handleMouse(mouse(top.indexOf("Details"), 0, { width: 72 }));
			expect(h.state.tab).toBe("info");
		});
	});

	describe("mode-owned targets", () => {
		it("lets help respond only to its own footer", () => {
			const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
			const row = h.listRow("echo check");
			h.menu.handleInput("?");
			h.menu.handleMouse(mouse(5, row));
			expect(h.state.selectedId).toBe("build");
			h.menu.handleMouse(mouse(2, 0));
			expect(h.frame()).toContain("Task controls");
			h.menu.handleMouse(mouse(footer(h).indexOf("Esc back") + 1, 29));
			expect(h.frame()).not.toContain("Task controls");
			expect(h.close).not.toHaveBeenCalled();
		});

		it("lets the stop question respond only to confirm and cancel", () => {
			const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
			const row = h.listRow("echo check");
			const detailsX = h.frame().split("\n")[0]!.indexOf("Details");
			h.menu.handleInput("k");
			h.menu.handleMouse(mouse(5, row));
			h.menu.handleMouse(mouse(detailsX, 0));
			h.menu.handleMouse(mouse(footer(h).indexOf("find") + 1, 29));
			expect(h.state.selectedId).toBe("build");
			expect(h.state.tab).toBe("output");
			expect(footer(h)).toContain('Stop Bash "echo build"?');
			h.menu.handleMouse(mouse(footer(h).indexOf("Esc cancel") + 1, 29));
			expect(footer(h)).not.toContain("Stop Bash");
			expect(h.host.kill).not.toHaveBeenCalled();
			h.menu.handleInput("k");
			h.menu.handleMouse(mouse(footer(h).indexOf("Enter stop") + 1, 29));
			expect(h.host.kill).toHaveBeenCalledExactlyOnceWith("build");
		});

		it("lets search respond to its candidates, not to the inspector's tabs", () => {
			const h = harness([backgroundTask("build"), backgroundTask("check")], { width: 120 });
			const detailsX = h.frame().split("\n")[0]!.indexOf("Details");
			h.menu.handleInput("/");
			h.menu.handleMouse(mouse(detailsX, 0));
			expect(h.state.tab).toBe("output");
			expect(footer(h)).toContain("Esc cancel");
			h.menu.handleInput("check");
			h.menu.handleMouse(mouse(5, h.listRow("echo check")));
			expect(h.state.selectedId).toBe("check");
			expect(footer(h)).not.toContain("Esc cancel");
		});

		it("starts a search from the footer hint", () => {
			const h = harness([backgroundTask("build")], { width: 120 });
			h.menu.handleMouse(mouse(footer(h).indexOf("find"), 29));
			expect(h.frame()).toContain("Find task:");
		});
	});

	it("scrolls the pane under the pointer in wide mode and ignores the wheel on the footer", async () => {
		const h = harness([backgroundTask("build")], { width: 120 });
		await vi.advanceTimersByTimeAsync(0);
		h.menu.handleMouse(mouse(100, 29, { type: "wheel", button: "none", wheelDelta: -3 }));
		expect(h.frame()).not.toContain("Browsing");
		h.menu.handleMouse(mouse(100, 10, { type: "wheel", button: "none", wheelDelta: -3 }));
		expect(h.frame()).toContain("Browsing");
	});

	it("focuses the pane that was clicked in wide mode", () => {
		const h = harness([backgroundTask("build")], { width: 120 });
		h.menu.handleMouse(mouse(100, 10));
		expect(footer(h)).toContain("← output");
		h.menu.handleMouse(mouse(10, 10));
		expect(footer(h)).toContain("Enter open");
	});

	describe("frame", () => {
		it("shows the list range in its bottom border only when the list overflows", () => {
			const few = harness([backgroundTask("build")], { width: 120 });
			expect(few.frame().split("\n").at(-2)).not.toMatch(/ of \d+/);
			const many = harness(
				Array.from({ length: 40 }, (_, i) => backgroundTask(`task-${i}`)),
				{ width: 120 },
			);
			expect(many.frame().split("\n").at(-2)).toMatch(/\d+-\d+ of 40 ─┘ /);
		});

		it("shows the reading state in the inspector's bottom border for logs only", async () => {
			const h = harness([backgroundTask("build")], { width: 120 });
			await vi.advanceTimersByTimeAsync(0);
			const bottom = () => h.frame().split("\n").at(-2)!;
			expect(bottom()).toMatch(/ Live ─┘$/);
			h.menu.handleInput("\t");
			h.menu.handleInput("\x1b[5~");
			expect(bottom()).toMatch(/ Browsing · f follow ─┘$/);
			h.menu.handleMouse(mouse(120 - "Browsing · f follow".length - 3, 28));
			expect(bottom()).toMatch(/ Live ─┘$/);
			const report = harness([task("agent", { output: "report", outputPath: undefined })], { width: 120 });
			expect(report.frame().split("\n").at(-2)).not.toMatch(/Live|Browsing|Finished/);
		});

		it("names the tail preview size beside the reading state", async () => {
			const h = harness([backgroundTask("build")], { width: 120 });
			h.host.read.mockResolvedValue({
				task: h.tasks[0]!,
				text: "tail",
				totalBytes: 5 * 1024 * 1024,
				truncated: true,
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.frame().split("\n").at(-2)).toContain("Live · Tail preview: 4B of 5.0MB");
		});

		it("shows the Details range in its bottom border only when Details overflow", () => {
			const command = Array.from({ length: 50 }, (_, i) => `echo parameter-${i}`).join("\n");
			const h = harness([
				task("long", { input: { label: "Script", text: command, truncated: false } }),
				task("short", { startedAt: -1 }),
			]);
			h.menu.handleInput("\t");
			h.menu.handleInput("\x1b[C");
			expect(h.frame().split("\n").at(-2)).toMatch(/\d+–\d+\/\d+ ─┘$/);
			h.menu.handleInput("\t");
			h.menu.handleInput("\x1b[B");
			expect(h.frame().split("\n").at(-2)).not.toMatch(/\d+–\d+\/\d+/);
		});
	});
});
describe("task panel inspector header and Details", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		initTheme("dark");
	});
	afterEach(() => {
		disposeMenus();
		vi.useRealTimers();
	});
	const rows = (h: ReturnType<typeof harness>) => h.frame().split("\n");

	it("sets the title in bold and separates the header from the tab with a rule joined to the frame", () => {
		const h = harness([task("build")], { width: 120 });
		const lines = h.menu.render(120);
		expect(lines[1]).toContain(theme.style("echo build", { fg: "text", bold: true }));
		const plain = rows(h);
		expect(plain[3]).toMatch(/^│.* ├─+┤$/);
		// The rule spans the pane, and the body starts below it.
		expect(plain[3]!.split(" ").at(-1)).toHaveLength(120 - 48 - 1);
		expect(plain[2]!.split("│")[3]).toContain("Bash · Running");
		expect(plain[4]!.split("│")[3]).toMatch(/^(No output yet|line-)/);
	});

	it("draws the rule in the pane's border color: accent when focused, muted otherwise", () => {
		const h = harness([task("build")], { width: 120 });
		const rule = () => h.menu.render(120)[3]!.split(" ").at(-1)!;
		expect(rule()).toBe(theme.fg("borderMuted", `├${"─".repeat(69)}┤`));
		h.menu.handleInput("\t");
		expect(rule()).toBe(theme.fg("borderAccent", `├${"─".repeat(69)}┤`));
	});

	it("draws the rule in a narrow inspector and not for the empty placeholder", () => {
		const narrow = harness([task("build")], { width: 72, height: 22 });
		narrow.menu.handleInput("\r");
		expect(rows(narrow)[3]).toMatch(/^├─+┤$/);
		const empty = harness([], { width: 120 });
		expect(empty.frame()).toContain("Select a task to inspect its result.");
		expect(empty.frame()).not.toContain("├");
	});

	it("wraps Details values in their own column with a hanging indent and breaks long paths", () => {
		const path = `C:\\Users\\someone\\Projects\\a-very-long-project-directory-name\\${"nested-".repeat(8)}end`;
		const command = "npm run build -- --watch --verbose --config ./configs/production.config.js --output ./dist/out";
		const h = harness(
			[
				task("build", {
					input: { label: "Command", text: command, truncated: false },
					facts: [["Directory", path]],
				}),
			],
			{ width: 120 },
		);
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		const body = rows(h)
			.map((line) => line.split("│")[3])
			.filter((line): line is string => line !== undefined);
		const at = (label: string) => body.findIndex((line) => line.startsWith(label));
		const column = "Directory".length + 1;
		const directory = at("Directory");
		// The value starts beside its label and every continuation hangs under it.
		let value = body[directory]!.slice(column).trimEnd();
		expect(value).not.toBe("");
		let next = directory + 1;
		while (body[next]?.startsWith(" ".repeat(column)) && body[next]!.trim()) {
			value += body[next]!.slice(column).trimEnd();
			next++;
		}
		expect(value).toBe(path);
		expect(next - directory).toBeGreaterThan(1);
		const commandRow = at("Command");
		expect(body[commandRow + 1]!.startsWith(" ".repeat(column))).toBe(true);
		expect(body[commandRow + 1]!.trim()).not.toBe("");
		for (const line of body) expect(visibleWidth(line)).toBeLessThanOrEqual(69);
	});

	it("rewraps Details when the terminal width changes", () => {
		const path = "/".concat("segment/".repeat(14), "end");
		const h = harness([task("build", { facts: [["Directory", path]] })], { width: 120 });
		h.menu.handleInput("\t");
		h.menu.handleInput("\x1b[C");
		const count = () => rows(h).filter((line) => line.split("│")[3]?.startsWith(" ".repeat(10))).length;
		const wide = count();
		h.tui.terminal.columns = 100;
		expect(count()).toBeGreaterThanOrEqual(wide);
		h.tui.terminal.columns = 150;
		expect(count()).toBeLessThanOrEqual(wide);
	});
});
