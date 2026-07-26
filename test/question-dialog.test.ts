import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createQuestionDialog } from "../src/extensions/question/dialog.ts";
import type { DialogResult, Question } from "../src/extensions/question/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const ESC = "\x1b";
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

function createDialog(questions: Question[], signal?: AbortSignal) {
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI;
	const results: DialogResult[] = [];
	const component = createQuestionDialog(questions, signal)(tui, theme, new KeybindingsManager(), (result) => {
		results.push(result);
	});
	component.focused = true;
	const view = () => stripAnsi(component.render(120).join("\n"));
	return { component, results, view };
}

describe("question dialog", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

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
