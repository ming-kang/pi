import { describe, expect, it } from "vitest";
import { firstUnanswered, newQuestionState, orderedAnswers } from "../src/extensions/question/state.ts";
import type { Question, QuestionState } from "../src/extensions/question/types.ts";

function question(overrides?: Partial<Question>): Question {
	return {
		question: "Which approach should we take?",
		header: "Approach",
		options: [
			{ label: "Alpha", description: "First" },
			{ label: "Beta", description: "Second" },
			{ label: "Gamma", description: "Third" },
		],
		...overrides,
	};
}

function answeredSingle(label: string): QuestionState {
	const state = newQuestionState();
	state.singleAnswer = {
		questionIndex: 0,
		question: "Which approach should we take?",
		header: "Approach",
		kind: "option",
		answer: label,
	};
	return state;
}

describe("firstUnanswered", () => {
	it("returns the index of the first question without an answer", () => {
		expect(firstUnanswered([answeredSingle("Alpha"), newQuestionState()])).toBe(1);
	});

	it("returns undefined when everything is answered", () => {
		expect(firstUnanswered([answeredSingle("Alpha")])).toBeUndefined();
	});

	it("treats a deselected custom answer as unanswered", () => {
		const state = newQuestionState();
		state.customAnswer = { text: "mine", selected: false };
		expect(firstUnanswered([state])).toBe(0);
	});
});

describe("orderedAnswers", () => {
	it("keeps notes only for the selected option", () => {
		const state = answeredSingle("Alpha");
		state.notesByOption.set("Alpha", "note a");
		state.notesByOption.set("Beta", "note b");
		const [answer] = orderedAnswers([question()], [state]);
		expect(answer.notes).toEqual([{ option: "Alpha", text: "note a" }]);
	});

	it("drops whitespace-only notes", () => {
		const state = answeredSingle("Alpha");
		state.notesByOption.set("Alpha", "   ");
		const [answer] = orderedAnswers([question()], [state]);
		expect(answer.notes).toBeUndefined();
	});

	it("orders multi selections by option index and appends the selected custom answer", () => {
		const state = newQuestionState();
		state.multiSelected = new Set([2, 0]);
		state.customAnswer = { text: "mine", selected: true };
		const [answer] = orderedAnswers([question({ multiSelect: true })], [state]);
		expect(answer.kind).toBe("multi");
		expect(answer.selected).toEqual(["Alpha", "Gamma", "mine"]);
		expect(answer.answer).toBeNull();
	});

	it("excludes a deselected custom answer and omits unanswered questions", () => {
		const state = newQuestionState();
		state.multiSelected = new Set([1]);
		state.customAnswer = { text: "mine", selected: false };
		const answers = orderedAnswers(
			[question({ multiSelect: true }), question({ question: "Second?", header: "Second" })],
			[state, newQuestionState()],
		);
		expect(answers).toHaveLength(1);
		expect(answers[0].selected).toEqual(["Beta"]);
	});
});
