import { Type } from "typebox";
import { QUESTION_LIMITS } from "./limits.ts";
import type { Question, QuestionOption, QuestionToolError } from "./types.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTIONS = 4;
const RESERVED_LABELS = ["Other", "Type something.", "Chat about this", "Next"] as const;

const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: QUESTION_LIMITS.optionLabelChars,
		description:
			"Short user-facing option label (1-5 words), distinct within the question. Reserved labels ('Other', 'Type something.', 'Chat about this', 'Next') are rejected — the UI adds the custom-answer path itself.",
	}),
	description: Type.String({
		maxLength: QUESTION_LIMITS.optionDescriptionChars,
		description: "One concise sentence explaining the option's meaning, consequence, or tradeoff.",
	}),
	preview: Type.Optional(
		Type.String({
			maxLength: QUESTION_LIMITS.previewChars,
			description:
				"Optional markdown preview shown only for focused single-select options; use for concrete snippets, layouts, copy, or config comparisons.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		maxLength: QUESTION_LIMITS.questionChars,
		description:
			"One clear, specific decision or preference question ending in a question mark. Ask only what is needed to proceed.",
	}),
	header: Type.String({
		maxLength: QUESTION_LIMITS.headerChars,
		description: "Very short decision label shown as a chip (max ~12 chars), e.g. 'Auth method'.",
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: "Mutually distinct options for this decision; do not include reserved custom-answer labels.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"Allow selecting multiple options only when choices can be combined. Defaults to false for mutually exclusive decisions.",
		}),
	),
});

export const QuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Related decisions to ask now (1-4); ask only what is needed to unblock progress.",
	}),
});

export function validateQuestions(
	questions: Question[],
): { ok: true } | { ok: false; error: QuestionToolError; message: string } {
	if (questions.length === 0)
		return { ok: false, error: "no_questions", message: "At least one question is required" };
	if (questions.length > MAX_QUESTIONS) {
		return { ok: false, error: "too_many_questions", message: `At most ${MAX_QUESTIONS} questions are allowed` };
	}

	const seenQuestions = new Set<string>();
	for (const q of questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: "Question text must be unique" };
		}
		seenQuestions.add(q.question);

		if (q.question.length > QUESTION_LIMITS.questionChars || q.header.length > QUESTION_LIMITS.headerChars) {
			return {
				ok: false,
				error: "invalid_text_length",
				message: "Question text or header exceeds its length limit",
			};
		}

		if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: "invalid_option_count",
				message: `Each question requires ${MIN_OPTIONS}-${MAX_OPTIONS} options`,
			};
		}

		const seenLabels = new Set<string>();
		for (const option of q.options as QuestionOption[]) {
			if (
				option.label.length > QUESTION_LIMITS.optionLabelChars ||
				option.description.length > QUESTION_LIMITS.optionDescriptionChars ||
				(option.preview?.length ?? 0) > QUESTION_LIMITS.previewChars
			) {
				return { ok: false, error: "invalid_text_length", message: "Option text exceeds its length limit" };
			}
			if ((RESERVED_LABELS as readonly string[]).includes(option.label)) {
				return {
					ok: false,
					error: "reserved_label",
					message: `Option label is reserved (${RESERVED_LABELS.join(", ")})`,
				};
			}
			if (seenLabels.has(option.label)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: "Option labels must be unique within a question",
				};
			}
			seenLabels.add(option.label);
		}
	}

	return { ok: true };
}
