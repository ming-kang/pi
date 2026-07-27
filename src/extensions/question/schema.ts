import { Type } from "typebox";
import { QUESTION_LIMITS } from "./limits.ts";
import type { Question, QuestionOption, QuestionToolError } from "./types.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTIONS = 4;
const RESERVED_LABELS = ["Other", "Type something", "Type something.", "Chat about this"] as const;

const normalizeLabel = (text: string) => text.trim().toLowerCase();
const RESERVED_NORMALIZED = new Set(RESERVED_LABELS.map(normalizeLabel));

const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: QUESTION_LIMITS.optionLabelChars,
		description:
			"Short user-facing option label (1-5 words), distinct within the question. Reserved labels ('Other', 'Type something', 'Chat about this') are rejected — the UI adds the custom-answer path itself.",
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
		description: "Very short decision label shown as a chip; aim for ~12 chars, max 32. E.g. 'Auth method'.",
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

/**
 * Checks the schema cannot express. Length and count limits are omitted:
 * the agent core validates params against `QuestionParams` before execute runs.
 */
export function validateQuestions(
	questions: Question[],
): { ok: true } | { ok: false; error: QuestionToolError; message: string } {
	const seenQuestions = new Set<string>();
	for (const q of questions) {
		const questionKey = normalizeLabel(q.question);
		if (seenQuestions.has(questionKey)) {
			return { ok: false, error: "duplicate_question", message: "Question text must be unique" };
		}
		seenQuestions.add(questionKey);

		if (q.multiSelect && q.options.some((option) => option.preview)) {
			return {
				ok: false,
				error: "preview_multiselect",
				message:
					"Option previews are not supported on multiSelect questions; drop the previews or make the question single-select",
			};
		}

		const seenLabels = new Set<string>();
		for (const option of q.options as QuestionOption[]) {
			const labelKey = normalizeLabel(option.label);
			if (RESERVED_NORMALIZED.has(labelKey)) {
				return {
					ok: false,
					error: "reserved_label",
					message: `Option label is reserved (${RESERVED_LABELS.join(", ")})`,
				};
			}
			if (seenLabels.has(labelKey)) {
				return {
					ok: false,
					error: "duplicate_option_label",
					message: "Option labels must be unique within a question",
				};
			}
			seenLabels.add(labelKey);
		}
	}

	return { ok: true };
}
