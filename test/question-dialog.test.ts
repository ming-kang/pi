import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createQuestionDialog } from "../src/extensions/question/dialog.ts";
import type { DialogResult, Question } from "../src/extensions/question/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const TAB = "\t";

function question(overrides?: Partial<Question>): Question {
	return {
		question: "Which approach should we take?",
		header: "Approach",
		options: [
			{ label: "Alpha", description: "First" },
			{ label: "Beta", description: "Second" },
		],
		...overrides,
	};
}

function createDialog(
	questions: Question[],
	signal?: AbortSignal,
	keybindings: KeybindingsManager = new KeybindingsManager(),
	dimensions: { rows: number; columns: number } = { rows: 40, columns: 120 },
) {
	const tui = { requestRender: () => {}, terminal: dimensions } as unknown as TUI;
	const results: DialogResult[] = [];
	const component = createQuestionDialog(questions, signal)(tui, theme, keybindings, (result) => {
		results.push(result);
	});
	component.focused = true;
	const viewAt = (width: number) => stripAnsi(component.render(width).join("\n"));
	const view = () => viewAt(120);
	return { component, results, view, viewAt };
}

describe("question dialog", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("shows numeric shortcuts, punctuation-free custom copy, and aligned option labels", () => {
		const singleOutput = createDialog([question()]).view();
		const multiOutput = createDialog([question({ multiSelect: true })]).view();
		expect(singleOutput).toContain("1-3 select • Tab notes/custom • Enter select • ←/→ questions • Esc cancel");
		expect(multiOutput).toContain(
			"1-3 toggle • Space toggle focused • Tab notes/custom • Enter continue • ←/→ questions • Esc cancel",
		);
		expect(singleOutput).toContain("Type something");
		expect(singleOutput).not.toContain("Type something.");
		const singleOption = singleOutput.split("\n").find((line) => line.includes("1. Alpha"));
		const multiOption = multiOutput.split("\n").find((line) => line.includes("1. Alpha"));
		expect(singleOption).toBeDefined();
		expect(multiOption).toBeDefined();
		expect(singleOption?.indexOf("1. Alpha")).toBe(multiOption?.indexOf("1. Alpha"));
	});

	it("wraps unified hints within narrow dialog widths", () => {
		const { component } = createDialog([question({ multiSelect: true })]);
		expect(component.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("uses unified key-action hints in every dialog mode", () => {
		const notes = createDialog([question()]);
		notes.component.handleInput(TAB);
		expect(notes.view()).toContain("Enter save notes • Esc back");

		const custom = createDialog([question()]);
		custom.component.handleInput("3");
		expect(custom.view()).toContain("Enter continue • Esc back");

		const multiCustom = createDialog([question({ multiSelect: true })]);
		multiCustom.component.handleInput(DOWN);
		multiCustom.component.handleInput(DOWN);
		multiCustom.component.handleInput(ENTER);
		expect(multiCustom.view()).toContain("Enter save custom answer • Esc back");

		const discuss = createDialog([question()]);
		discuss.component.handleInput(DOWN);
		discuss.component.handleInput(DOWN);
		discuss.component.handleInput(DOWN);
		expect(discuss.view()).toContain("Enter discuss • ↑ return to options • Esc cancel");

		const review = createDialog([question(), question({ question: "Second?", header: "Second" })]);
		review.component.handleInput(ENTER);
		review.component.handleInput(ENTER);
		expect(review.view()).toContain("Enter submit • Esc edit last question");
	});

	it("shows only the first injected custom binding", () => {
		const keybindings = new KeybindingsManager({
			"tui.input.submit": ["ctrl+s", "enter"],
			"tui.input.tab": ["ctrl+t", "tab"],
			"tui.select.confirm": ["ctrl+x", "enter"],
			"tui.select.cancel": ["ctrl+g", "escape"],
			"tui.editor.cursorLeft": ["alt+h", "left"],
			"tui.editor.cursorRight": ["alt+l", "right"],
		});
		const dialog = createDialog([question()], undefined, keybindings);
		const output = dialog.view();
		expect(output).toContain(
			`${process.platform === "darwin" ? "Option" : "Alt"}+H/${process.platform === "darwin" ? "Option" : "Alt"}+L questions`,
		);
		expect(output).toContain("Ctrl+T notes/custom • Ctrl+X select");
		expect(output).toContain("Ctrl+G cancel");
		expect(output).not.toContain("escape/ctrl+c");

		dialog.component.handleInput(TAB);
		expect(dialog.view()).toContain("Enter save notes • Ctrl+G back");
		expect(dialog.view()).not.toContain("Ctrl+S save notes");
	});

	it("selects an option by digit and submits a single single-select question", () => {
		const { component, results } = createDialog([question()]);
		component.handleInput("2");
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("answered");
		expect(results[0].answers[0].answer).toBe("Beta");
	});

	it("toggles multi-select options by digit", () => {
		const { component, results, view } = createDialog([question({ multiSelect: true })]);
		component.handleInput("2");
		expect(view()).toContain("[x]");
		component.handleInput("2");
		expect(view()).not.toContain("[x]");
		expect(results).toHaveLength(0);
	});

	it("opens the custom-answer input when the other row's digit is pressed", () => {
		const { component, view } = createDialog([question()]);
		component.handleInput("3");
		expect(view()).toContain("Your answer:");
	});

	it("opens the custom-answer input on enter at the other row in multi-select", () => {
		const { component, view } = createDialog([question({ multiSelect: true })]);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		const output = view();
		expect(output).toContain("Your answer:");
		expect(output).not.toContain("Select at least one option");
	});

	it("restores the previous selection when notes input is cancelled", () => {
		const { component, view } = createDialog([question(), question({ question: "Second?", header: "Second" })]);
		component.handleInput(ENTER); // answer Q1 with Alpha, advance to Q2
		component.handleInput(LEFT); // back to Q1
		component.handleInput(DOWN); // focus Beta
		component.handleInput(TAB); // notes input selects Beta
		expect(view()).toContain("Beta ✓");
		component.handleInput(ESC);
		const output = view();
		expect(output).toContain("Alpha ✓");
		expect(output).not.toContain("Beta ✓");
	});

	it("keeps the new selection when notes are saved", () => {
		const { component, view } = createDialog([question(), question({ question: "Second?", header: "Second" })]);
		component.handleInput(ENTER);
		component.handleInput(LEFT);
		component.handleInput(DOWN);
		component.handleInput(TAB);
		for (const char of "needs sso") component.handleInput(char);
		component.handleInput(ENTER);
		const output = view();
		expect(output).toContain("Beta ✓");
		expect(output).toContain("+note");
	});

	it("keeps the focused option and footer visible inside a 24-row narrow viewport", () => {
		const questions = [
			question({
				question: "Choose one approach for this deliberately narrow terminal layout?",
				options: Array.from({ length: 4 }, (_, index) => ({
					label: `Option ${index + 1}`,
					description: `Description ${index + 1} ${"with enough detail to wrap ".repeat(4)}`,
				})),
			}),
		];
		const dialog = createDialog(questions, undefined, new KeybindingsManager(), { rows: 24, columns: 36 });
		const initialLines = dialog.component.render(36);
		expect(initialLines.length).toBeLessThanOrEqual(24);
		expect(initialLines.every((line) => visibleWidth(line) <= 36)).toBe(true);
		expect(stripAnsi(initialLines.join("\n"))).toContain("↓");

		for (let index = 0; index < 4; index++) dialog.component.handleInput(DOWN);
		const lastOption = dialog.viewAt(36);
		expect(lastOption).toMatch(/→\s+5\. Type something/);
		expect(lastOption).toContain("↑");

		dialog.component.handleInput(DOWN);
		const footer = dialog.viewAt(36);
		expect(footer).toMatch(/→\s+Chat about this/);
		expect(dialog.component.render(36).length).toBeLessThanOrEqual(24);
	});

	it("keeps the focused option beside its stacked preview in a short terminal", () => {
		const dialog = createDialog(
			[
				question({
					options: [
						{
							label: "Alpha",
							description: "First option",
							preview: Array.from({ length: 20 }, (_, index) => `PREVIEW-${index + 1}`).join("\n"),
						},
						{ label: "Beta", description: "Second option" },
					],
				}),
			],
			undefined,
			new KeybindingsManager(),
			{ rows: 40, columns: 40 },
		);
		const output = dialog.viewAt(40);
		expect(output).toMatch(/→\s+1\. Alpha/);
		expect(output).toContain("PREVIEW-1");
		expect(output).toContain("more lines");
		expect(dialog.component.render(40).length).toBeLessThanOrEqual(20);
	});

	describe("height budget", () => {
		const previewOf = (option: number, lines: number) =>
			Array.from({ length: lines }, (_, line) => `P${option}-${line + 1}`).join("\n");
		const previewOptions = (lines: number, count = 5) =>
			Array.from({ length: count }, (_, index) => ({
				label: `Option ${index + 1}`,
				description: `Description ${index + 1}`,
				preview: previewOf(index + 1, lines),
			}));
		const plainOptions = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				label: `Option ${index + 1}`,
				description: `Description ${index + 1}`,
			}));
		const visibleOptionNumbers = (output: string) =>
			[...output.matchAll(/^\s*[→ ]\s+(\d+)\. Option/gm)].map((match) => Number(match[1]));

		it("leaves at least half of a tall terminal to the transcript", () => {
			for (const [rows, columns] of [
				[40, 120],
				[40, 50],
				[60, 100],
			]) {
				const dialog = createDialog(
					[question({ options: previewOptions(30, 8) })],
					undefined,
					new KeybindingsManager(),
					{ rows, columns },
				);
				expect(dialog.component.render(columns).length).toBeLessThanOrEqual(Math.floor(rows / 2));
			}
		});

		it("never exceeds the terminal on very short terminals", () => {
			const dialog = createDialog(
				[question({ options: previewOptions(30, 8) })],
				undefined,
				new KeybindingsManager(),
				{ rows: 10, columns: 100 },
			);
			expect(dialog.component.render(100).length).toBeLessThanOrEqual(10);
		});

		it("keeps tabs, the question, chat row, and key hints visible while scrolled to the last option", () => {
			const dialog = createDialog(
				[question({ options: plainOptions(8) }), question({ question: "Second?", header: "Second" })],
				undefined,
				new KeybindingsManager(),
				{ rows: 30, columns: 120 },
			);
			for (let index = 0; index < 8; index++) dialog.component.handleInput(DOWN);
			expect(dialog.component.render(120).length).toBeLessThanOrEqual(16);
			const output = dialog.viewAt(120);
			expect(output).toMatch(/→\s+9\. Type something/);
			expect(output).toContain("Approach");
			expect(output).toContain("Which approach should we take?");
			expect(output).toContain("Second");
			expect(output).toContain("Chat about this");
			expect(output).toContain("Esc cancel");
			expect(output).toMatch(/↑ \d+ more options?/);
			expect(output).not.toContain("↓");
		});

		it("says how many options are below and shows only whole options", () => {
			const dialog = createDialog([question({ options: plainOptions(8) })], undefined, new KeybindingsManager(), {
				rows: 24,
				columns: 100,
			});
			const output = dialog.viewAt(100);
			const hint = output.match(/↓ (\d+) more options?/);
			expect(hint).not.toBeNull();
			expect(output).not.toContain("↑");
			const visible = visibleOptionNumbers(output);
			expect(visible[0]).toBe(1);
			expect(visible.length + Number(hint?.[1])).toBe(9);
			for (const number of visible) expect(output).toContain(`Description ${number}`);
		});

		it("shows no more-options hint when every option fits", () => {
			const output = createDialog([question({ options: plainOptions(3) })]).view();
			expect(output).not.toMatch(/more options?/);
		});

		it("shows the whole preview beside a focused option that sits deep in the list", () => {
			const dialog = createDialog([question({ options: previewOptions(6) })], undefined, new KeybindingsManager(), {
				rows: 30,
				columns: 120,
			});
			dialog.component.handleInput(DOWN);
			dialog.component.handleInput(DOWN);
			dialog.component.handleInput(DOWN);
			const output = dialog.viewAt(120);
			expect(output).toMatch(/→\s+4\. Option 4/);
			for (let line = 1; line <= 6; line++) expect(output).toContain(`P4-${line}`);
			expect(output).not.toContain("more lines");
			expect(dialog.component.render(120).length).toBeLessThanOrEqual(16);
		});

		it("starts the preview at the top of the option area, whichever option is focused", () => {
			const dialog = createDialog([question({ options: previewOptions(6) })], undefined, new KeybindingsManager(), {
				rows: 30,
				columns: 120,
			});
			const firstPreviewRow = (output: string, option: number) =>
				output.split("\n").findIndex((line) => line.includes(`P${option}-1`));
			const before = firstPreviewRow(dialog.viewAt(120), 1);
			dialog.component.handleInput(DOWN);
			dialog.component.handleInput(DOWN);
			expect(firstPreviewRow(dialog.viewAt(120), 3)).toBe(before);
		});

		describe("narrow layout", () => {
			const wrappedOptions = Array.from({ length: 5 }, (_, index) => ({
				label: `Option ${index + 1}`,
				description: `Description ${index + 1} ${"wraps across several lines ".repeat(2)}end${index + 1}`,
				preview: previewOf(index + 1, 12),
			}));
			const open = (rows: number) => {
				const dialog = createDialog(
					[question({ options: wrappedOptions }), question({ question: "Second?", header: "Second" })],
					undefined,
					new KeybindingsManager(),
					{ rows, columns: 50 },
				);
				dialog.component.handleInput(DOWN);
				return dialog;
			};

			it("keeps the whole focused option and both hints when the preview cannot fit", () => {
				const dialog = open(30);
				const output = dialog.viewAt(50);
				expect(output).toMatch(/→\s+2\. Option 2/);
				expect(output).toContain("end2");
				expect(output).toMatch(/↑ \d+ more options?/);
				expect(output).toMatch(/↓ \d+ more options?/);
				expect(output).toContain("Esc cancel");
				expect(dialog.component.render(50).length).toBeLessThanOrEqual(16);
			});

			it("gives the preview only the rows the option window leaves", () => {
				const dialog = open(40);
				const output = dialog.viewAt(50);
				expect(output).toMatch(/→\s+2\. Option 2/);
				expect(output).toContain("end2");
				expect(output).toMatch(/↓ \d+ more options?/);
				expect(output).toContain("P2-1");
				expect(output).toContain("more lines");
				expect(dialog.component.render(50).length).toBeLessThanOrEqual(20);
			});
		});

		it("clips a tall preview to the option area and says how many lines are left", () => {
			const dialog = createDialog([question({ options: previewOptions(40) })], undefined, new KeybindingsManager(), {
				rows: 30,
				columns: 120,
			});
			dialog.component.handleInput(DOWN);
			dialog.component.handleInput(DOWN);
			const output = dialog.viewAt(120);
			expect(output).toContain("P3-1");
			expect(output).toMatch(/… \d+ more lines/);
			expect(output).toContain("Esc cancel");
			expect(dialog.component.render(120).length).toBeLessThanOrEqual(16);
		});

		it("scrolls the options and the preview independently", () => {
			const dialog = createDialog(
				[question({ options: previewOptions(40, 12) })],
				undefined,
				new KeybindingsManager(),
				{ rows: 30, columns: 120 },
			);
			for (let index = 0; index < 11; index++) dialog.component.handleInput(DOWN);
			const output = dialog.viewAt(120);
			expect(output).toMatch(/→\s+12\. Option 12/);
			expect(output).toMatch(/↑ \d+ more options?/);
			expect(output).toContain("P12-1");
		});
	});

	it("scrolls long review content without losing submit and edit behavior", () => {
		const questions = Array.from({ length: 4 }, (_, index) =>
			question({
				question: `Question ${index + 1}: ${"long decision context ".repeat(12)}?`,
				header: `Q${index + 1}`,
			}),
		);
		const dialog = createDialog(questions, undefined, new KeybindingsManager(), { rows: 24, columns: 34 });
		for (let index = 0; index < questions.length; index++) dialog.component.handleInput(ENTER);
		const initial = dialog.viewAt(34);
		expect(initial).toContain("Review answers");
		expect(initial).toContain("↓");
		dialog.component.handleInput(DOWN);
		const scrolled = dialog.viewAt(34);
		expect(scrolled).not.toBe(initial);
		expect(scrolled).toContain("↑");
		expect(dialog.component.render(34).length).toBeLessThanOrEqual(24);
		dialog.component.handleInput(UP);
		expect(dialog.viewAt(34)).toContain("Review answers");
		dialog.component.handleInput(ENTER);
		expect(dialog.results).toHaveLength(1);
		expect(dialog.results[0].outcome).toBe("answered");
	});

	it("cancels with partial answers when the abort signal fires, exactly once", () => {
		const controller = new AbortController();
		const { component, results } = createDialog(
			[question(), question({ question: "Second?", header: "Second" })],
			controller.signal,
		);
		component.handleInput(ENTER); // answer Q1
		controller.abort();
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("cancelled");
		expect(results[0].answers).toHaveLength(1);
		component.handleInput(ENTER); // any further finish attempt is ignored
		expect(results).toHaveLength(1);
	});

	it("resolves immediately when created with an already-aborted signal", () => {
		const controller = new AbortController();
		controller.abort();
		const { results } = createDialog([question()], controller.signal);
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("cancelled");
		expect(results[0].answers).toHaveLength(0);
	});

	it("does not fire the abort handler after dispose", () => {
		const controller = new AbortController();
		const { component, results } = createDialog([question()], controller.signal);
		component.handleInput(ENTER); // answered → done
		component.dispose();
		controller.abort();
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe("answered");
	});
});
