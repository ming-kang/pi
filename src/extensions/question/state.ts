import type { AnswerNote, DisplayOption, Question, QuestionAnswer, QuestionState } from "./types.ts";
import { OTHER_OPTION } from "./types.ts";

export function newQuestionState(question: Question): QuestionState {
	return {
		focus: 0,
		draft: question.multiSelect ? { kind: "multi", selected: new Set() } : { kind: "single" },
		notes: new Map(),
	};
}

export function displayOptions(question: Question): DisplayOption[] {
	return [
		...question.options.map((option, optionIndex) => ({ ...option, kind: "option" as const, optionIndex })),
		OTHER_OPTION,
	];
}

export function hasAnswer(state: QuestionState): boolean {
	const draft = state.draft;
	if (draft.kind === "single") return draft.choice !== undefined;
	return draft.selected.size > 0 || draft.custom?.selected === true;
}

/** The saved custom text, whether or not it is currently selected. */
export function customText(state: QuestionState): string | undefined {
	const draft = state.draft;
	if (draft.kind === "multi") return draft.custom?.text;
	return draft.choice?.kind === "custom" ? draft.choice.text : undefined;
}

export function isSelected(state: QuestionState, option: DisplayOption): boolean {
	const draft = state.draft;
	if (draft.kind === "multi") {
		return option.kind === "other" ? draft.custom?.selected === true : draft.selected.has(option.optionIndex);
	}
	if (option.kind === "other") return draft.choice?.kind === "custom";
	return draft.choice?.kind === "option" && draft.choice.index === option.optionIndex;
}

export function firstUnanswered(states: readonly QuestionState[]): number | undefined {
	const index = states.findIndex((state) => !hasAnswer(state));
	return index === -1 ? undefined : index;
}

function selectedNotes(question: Question, state: QuestionState, indices: readonly number[]): AnswerNote[] | undefined {
	const notes: AnswerNote[] = [];
	for (const index of indices) {
		const text = state.notes.get(index)?.trim();
		if (text) notes.push({ option: question.options[index].label, text });
	}
	return notes.length ? notes : undefined;
}

/** Build the tool-facing answers for every answered question, in question order. */
export function orderedAnswers(questions: readonly Question[], states: readonly QuestionState[]): QuestionAnswer[] {
	const answers: QuestionAnswer[] = [];
	for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
		const question = questions[questionIndex];
		const draft = states[questionIndex].draft;
		const base = { questionIndex, question: question.question, header: question.header };

		if (draft.kind === "single") {
			const choice = draft.choice;
			if (choice?.kind === "custom") answers.push({ ...base, kind: "custom", answer: choice.text });
			if (choice?.kind === "option") {
				const option = question.options[choice.index];
				const notes = selectedNotes(question, states[questionIndex], [choice.index]);
				answers.push({
					...base,
					kind: "option",
					answer: option.label,
					...(option.preview ? { preview: option.preview } : {}),
					...(notes ? { notes } : {}),
				});
			}
			continue;
		}

		if (!hasAnswer(states[questionIndex])) continue;
		const indices = [...draft.selected].sort((a, b) => a - b);
		const selected = indices.map((index) => question.options[index].label);
		if (draft.custom?.selected) selected.push(draft.custom.text);
		const notes = selectedNotes(question, states[questionIndex], indices);
		answers.push({ ...base, kind: "multi", answer: null, selected, ...(notes ? { notes } : {}) });
	}
	return answers;
}
