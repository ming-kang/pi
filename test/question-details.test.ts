import { setKeybindings, type TUI, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createQuestionDialog } from "../src/extensions/question/dialog.ts";
import type { DialogResult, Question } from "../src/extensions/question/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[1;3B";
const PAGE_UP = "\x1b[1;3A";
const pageHint = `${process.platform === "darwin" ? "Option" : "Alt"}+↑/${process.platform === "darwin" ? "Option" : "Alt"}+↓`;
const options = Array.from({ length: 4 }, (_, index) => ({
	label: `Option ${index + 1}`,
	description: `Description ${index + 1}: ${"consequence and trade-off ".repeat(8)}END-DESCRIPTION-${index + 1}`,
	preview: Array.from({ length: 40 }, (_, line) => `P${index + 1}-${line + 1}`).join("\n"),
}));

function open(dimensions = { rows: 32, columns: 100 }, keybindings = new KeybindingsManager(), choices = options) {
	const questions: Question[] = [
		{ header: "Approach", question: "Which approach should we take?", options: choices },
		{
			header: "Second",
			question: "Second?",
			options: [
				{ label: "Yes", description: "Continue" },
				{ label: "No", description: "Stop" },
			],
		},
	];
	const results: DialogResult[] = [];
	const tui = { requestRender: () => {}, terminal: dimensions } as unknown as TUI;
	const component = createQuestionDialog(questions)(tui, theme, keybindings, (result) => results.push(result));
	component.focused = true;
	const view = () => stripAnsi(component.render(dimensions.columns).join("\n"));
	return { component, view, results };
}

describe("question choices and details", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("uses the header as a tab label without repeating it before the question", () => {
		const dialog = open();
		expect(
			dialog
				.view()
				.split("\n")
				.map((line) => line.trim()),
		).toContain("Which approach should we take?");
		expect(dialog.view().match(/Approach/g)).toHaveLength(1);
		dialog.component.handleInput("\x1b[C");
		expect(
			dialog
				.view()
				.split("\n")
				.map((line) => line.trim()),
		).toContain("Second?");
	});

	it("keeps short choices compact as the terminal widens and gives the extra columns to details", () => {
		const dialog = open();
		const dividerAt = (columns: number) => {
			const row = stripAnsi(dialog.component.render(columns).join("\n"))
				.split("\n")
				.find((line) => line.includes(" │ "));
			expect(row).toBeDefined();
			return visibleWidth(row?.split(" │ ")[0] ?? "");
		};
		const initial = dividerAt(100);
		expect(dividerAt(160)).toBe(initial);
		dialog.component.handleInput(DOWN);
		expect(dividerAt(160)).toBe(initial);
	});

	it.each(["workspace-dependency-build-analysis", "跨项目依赖分析与增量构建方案（推荐）"])(
		"fits longer choice labels when half of the terminal is enough: %s",
		(label) => {
			const dialog = open(undefined, undefined, [{ ...options[0], label }, options[1]]);
			const row = dialog
				.view()
				.split("\n")
				.find((line) => line.startsWith("→"));
			expect(row?.split(" │ ")[0]).toContain(label);
			dialog.component.handleInput("\t");
			dialog.component.handleInput("\r");
			const selected = dialog
				.view()
				.split("\n")
				.find((line) => line.startsWith("→"));
			expect(selected?.split(" │ ")[0]).toContain(`${label} ✓`);
			expect(visibleWidth(selected?.split(" │ ")[0] ?? "")).toBe(visibleWidth(row?.split(" │ ")[0] ?? ""));
		},
	);

	it.each([72, 160])("reserves at least half of the usable width for details at %i columns", (columns) => {
		const label = "a".repeat(80);
		const dialog = open({ rows: 32, columns }, undefined, [{ ...options[0], label }, options[1]]);
		const lines = dialog.component.render(columns);
		expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
		const row = stripAnsi(lines.join("\n"))
			.split("\n")
			.find((line) => line.includes(" │ "));
		expect(row).toBeDefined();
		const left = visibleWidth(row?.split(" │ ")[0] ?? "");
		expect(columns - left - 3).toBeGreaterThanOrEqual(left);
	});

	it("keeps every short option label beside a long preview at half height", () => {
		const dialog = open();
		const output = dialog.view();
		for (let index = 1; index <= 4; index++) expect(output).toContain(`${index}. Option ${index}`);
		expect(output).toContain("5. Type something");
		expect(output).toContain("Description 1");
		expect(output).toContain("Preview");
		expect(output).toContain(pageHint);
		expect(output).toContain("Chat about this");
		expect(output).toContain("Esc cancel");
		expect(dialog.component.render(100).length).toBeLessThanOrEqual(16);
	});

	it.each([
		[100, 32],
		[50, 30],
		[36, 24],
	])("reads all details at %i columns and %i rows without changing the answer", (columns, rows) => {
		const dialog = open({ rows, columns });
		const seen: string[] = [];
		for (let page = 0; page < 100; page++) {
			const lines = dialog.component.render(columns);
			expect(lines.length).toBeLessThanOrEqual(16);
			expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
			const output = stripAnsi(lines.join("\n"));
			expect(output).toMatch(/→\s+1\. Option 1/);
			expect(output).toContain("Esc cancel");
			seen.push(output);
			dialog.component.handleInput(PAGE_DOWN);
		}
		expect(seen.join("\n")).toContain("END-DESCRIPTION-1");
		for (let line = 1; line <= 40; line++) expect(seen.join("\n")).toContain(`P1-${line}`);
		expect(dialog.view()).toContain("P1-40");
		expect(dialog.results).toHaveLength(0);
		dialog.component.handleInput("\r");
		dialog.component.handleInput("\x1b");
		expect(dialog.results[0].answers[0].answer).toBe("Option 1");
	});

	it("resets details on option change and hides stale previews on custom and chat rows", () => {
		const dialog = open();
		const first = dialog.view();
		dialog.component.handleInput(PAGE_DOWN);
		expect(dialog.view()).not.toBe(first);
		dialog.component.handleInput(PAGE_UP);
		expect(dialog.view()).toBe(first);
		dialog.component.handleInput(PAGE_DOWN);
		dialog.component.handleInput(DOWN);
		expect(dialog.view()).toContain("Description 2");
		expect(dialog.view()).not.toContain("P1-");
		for (let index = 0; index < 3; index++) dialog.component.handleInput(DOWN);
		expect(dialog.view()).toMatch(/→\s+5\. Type something/);
		expect(dialog.view()).not.toContain("P2-");
		dialog.component.handleInput(DOWN);
		expect(dialog.view()).toMatch(/→\s+Chat about this/);
		expect(dialog.view()).not.toContain("Preview");
	});

	it("pages the newly focused choice when a page key arrives before the redraw", () => {
		const dialog = open();
		dialog.view();
		dialog.component.handleInput(DOWN);
		dialog.component.handleInput(PAGE_DOWN);
		const output = dialog.view();
		expect(output).toMatch(/→\s+2\. Option 2/);
		expect(output).toMatch(/ [2-9]\d*–\d+\/\d+/);
		expect(output).not.toContain("Description 2");
	});

	it("starts a newly focused choice at the top when it was paged before moving", () => {
		const dialog = open();
		dialog.view();
		dialog.component.handleInput(PAGE_DOWN);
		dialog.component.handleInput(DOWN);
		const output = dialog.view();
		expect(output).toMatch(/→\s+2\. Option 2/);
		expect(output).toMatch(/ 1–\d+\/\d+/);
		expect(output).toContain("Description 2");
	});

	it("reflows on resize alone and clamps a scrolled preview when more rows become available", () => {
		const dimensions = { rows: 30, columns: 100 };
		const dialog = open(dimensions);
		dialog.view();
		for (let index = 0; index < 50; index++) {
			dialog.component.handleInput(PAGE_DOWN);
			dialog.view();
		}
		dimensions.columns = 50;
		dimensions.rows = 60;
		const resized = dialog.component.render(50);
		expect(resized.length).toBeLessThanOrEqual(30);
		expect(resized.every((line) => visibleWidth(line) <= 50)).toBe(true);
		expect(stripAnsi(resized.join("\n"))).toContain("P1-40");
		dimensions.rows = 10;
		expect(dialog.component.render(50).length).toBeLessThanOrEqual(10);
	});

	it("uses configured paging bindings and omits unbound hints", () => {
		const dialog = open(
			undefined,
			new KeybindingsManager({ "app.question.pageDown": "ctrl+n", "app.question.pageUp": [] }),
		);
		const first = dialog.view();
		expect(first).toContain("Ctrl+N");
		expect(first).not.toContain(pageHint);
		dialog.component.handleInput(PAGE_DOWN);
		expect(dialog.view()).toBe(first);
		dialog.component.handleInput("\x0e");
		expect(dialog.view()).not.toBe(first);
	});

	it("routes detail paging through fullscreen without scrolling the transcript", async () => {
		const terminal = new VirtualTerminal(100, 32);
		const tui = new TuiAltScreen(terminal);
		const component = createQuestionDialog([{ header: "Approach", question: "Which approach?", options }])(
			tui,
			theme,
			new KeybindingsManager(),
			() => {},
		);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		try {
			await terminal.waitForRender();
			const first = stripAnsi(component.render(100).join("\n"));
			const transcriptTop = tui.viewportTop;
			terminal.sendInput(PAGE_DOWN);
			await terminal.waitForRender();
			expect(stripAnsi(component.render(100).join("\n"))).not.toBe(first);
			expect(tui.viewportTop).toBe(transcriptTop);
			terminal.sendInput(PAGE_UP);
			await terminal.waitForRender();
			expect(stripAnsi(component.render(100).join("\n"))).toBe(first);
		} finally {
			component.dispose();
			tui.stop();
		}
	});

	it("keeps multiline custom answers on one choice row and preserves their full text", () => {
		const dialog = open({ rows: 30, columns: 50 });
		dialog.component.handleInput("5");
		for (const char of "First line") dialog.component.handleInput(char);
		dialog.component.handleInput("\x0a");
		for (const char of "Second line") dialog.component.handleInput(char);
		dialog.component.handleInput("\r");
		dialog.component.handleInput("\x1b[D");
		const lines = dialog.component.render(50);
		expect(lines.every((line) => !line.includes("\n") && visibleWidth(line) <= 50)).toBe(true);
		expect(dialog.view()).toContain("First line");
		expect(dialog.view()).toContain("Second line");
		dialog.component.handleInput("\x1b");
		expect(dialog.results[0].answers[0].answer).toBe("First line\nSecond line");
	});

	it("keeps multiline option labels out of terminal control rows", () => {
		const dialog = open(undefined, undefined, [{ ...options[0], label: "First\nsecond" }, options[1]]);
		expect(dialog.component.render(100).every((line) => !line.includes("\n"))).toBe(true);
		expect(dialog.view()).toContain("First second");
		dialog.component.handleInput("\r");
		dialog.component.handleInput("\x1b");
		expect(dialog.results[0].answers[0].answer).toBe("First\nsecond");
	});

	it("keeps the cursor and save hint visible while writing a long multiline note", () => {
		const dialog = open({ rows: 30, columns: 50 });
		dialog.component.handleInput("\t");
		for (let line = 1; line <= 14; line++) {
			for (const char of `Note line ${line}`) dialog.component.handleInput(char);
			if (line < 14) dialog.component.handleInput("\x0a");
		}
		const output = dialog.view();
		expect(output).toContain("Note line 14");
		expect(output).toContain("Notes for Option 1:");
		expect(output).toContain("Enter save notes");
		expect(dialog.component.render(50).length).toBeLessThanOrEqual(16);
		dialog.component.handleInput("\r");
		dialog.component.handleInput("\r");
		dialog.component.handleInput("\x1b");
		expect(dialog.results[0].answers[0].notes?.[0].text).toContain("Note line 14");
	});

	it("makes long labels, descriptions and saved notes readable without a preview", () => {
		const label = `${"长标签中文🙂".repeat(6)}LABEL-END`;
		const dialog = open({ rows: 30, columns: 50 }, undefined, [
			{ label, description: options[0].description, preview: "" },
			options[1],
		]);
		dialog.component.handleInput("\t");
		for (const char of "NOTE-END") dialog.component.handleInput(char);
		dialog.component.handleInput("\r");
		const seen: string[] = [];
		for (let page = 0; page < 30; page++) {
			seen.push(dialog.view());
			dialog.component.handleInput(PAGE_DOWN);
		}
		const output = seen.join("\n");
		expect(output).toContain("LABEL-END");
		expect(output).toContain("END-DESCRIPTION-1");
		expect(output).toContain("NOTE-END");
	});
});
