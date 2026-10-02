import { describe, expect, it } from "vitest";
import { firstUnanswered, newQuestionState, orderedAnswers } from "../src/extensions/question/state.ts";
import type { Question, QuestionState } from "../src/extensions/question/types.ts";

function question(overrides?: Partial<Question>): Question {
	return {
		question: "Which approach should we take?",
		header: "Approach",
		options: [
			{ label: "Alpha", description: "First" },
			{ label: "Beta", description: "Second", preview: "beta preview" },
			{ label: "Gamma", description: "Third" },
		],
		...overrides,
	};
}

function answeredSingle(index: number): QuestionState {
	const state = newQuestionState(question());
	state.draft = { kind: "single", choice: { kind: "option", index } };
	return state;
}

function multi(selected: number[], custom?: { text: string; selected: boolean }): QuestionState {
	const state = newQuestionState(question({ multiSelect: true }));
	state.draft = { kind: "multi", selected: new Set(selected), ...(custom ? { custom } : {}) };
	return state;
}

describe("firstUnanswered", () => {
	it("returns the index of the first question without an answer", () => {
		expect(firstUnanswered([answeredSingle(0), newQuestionState(question())])).toBe(1);
	});

	it("returns undefined when everything is answered", () => {
		expect(firstUnanswered([answeredSingle(0)])).toBeUndefined();
	});

	it("treats a deselected custom answer as unanswered", () => {
		expect(firstUnanswered([multi([], { text: "mine", selected: false })])).toBe(0);
	});
});

describe("orderedAnswers", () => {
	it("builds a single-select answer with its preview and only the selected option's note", () => {
		const state = answeredSingle(1);
		state.notes.set(0, "note a");
		state.notes.set(1, "note b");
		const [answer] = orderedAnswers([question()], [state]);
		expect(answer).toEqual({
			questionIndex: 0,
			question: "Which approach should we take?",
			header: "Approach",
			kind: "option",
			answer: "Beta",
			preview: "beta preview",
			notes: [{ option: "Beta", text: "note b" }],
		});
	});

	it("builds a custom single-select answer", () => {
		const state = newQuestionState(question());
		state.draft = { kind: "single", choice: { kind: "custom", text: "mine" } };
		const [answer] = orderedAnswers([question()], [state]);
		expect(answer).toMatchObject({ kind: "custom", answer: "mine" });
		expect(answer.notes).toBeUndefined();
	});

	it("drops whitespace-only notes", () => {
		const state = answeredSingle(0);
		state.notes.set(0, "   ");
		const [answer] = orderedAnswers([question()], [state]);
		expect(answer.notes).toBeUndefined();
	});

	it("orders multi selections by option index and appends the selected custom answer", () => {
		const state = multi([2, 0], { text: "mine", selected: true });
		state.notes.set(2, "gamma note");
		state.notes.set(1, "unselected note");
		const [answer] = orderedAnswers([question({ multiSelect: true })], [state]);
		expect(answer.kind).toBe("multi");
		expect(answer.selected).toEqual(["Alpha", "Gamma", "mine"]);
		expect(answer.answer).toBeNull();
		expect(answer.notes).toEqual([{ option: "Gamma", text: "gamma note" }]);
	});

	it("never attaches an option's note to custom text that repeats its label", () => {
		const state = multi([], { text: "Alpha", selected: true });
		state.notes.set(0, "note for the real Alpha");
		const [answer] = orderedAnswers([question({ multiSelect: true })], [state]);
		expect(answer.selected).toEqual(["Alpha"]);
		expect(answer.notes).toBeUndefined();
	});

	it("excludes a deselected custom answer and omits unanswered questions", () => {
		const answers = orderedAnswers(
			[question({ multiSelect: true }), question({ question: "Second?", header: "Second" })],
			[multi([1], { text: "mine", selected: false }), newQuestionState(question())],
		);
		expect(answers).toHaveLength(1);
		expect(answers[0].selected).toEqual(["Beta"]);
	});
});
