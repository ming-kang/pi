/**
 * constants.ts — question tool identity + prompt copy.
 *
 * Name/label/description/promptSnippet/promptGuidelines live here so
 * `index.ts` only assembles the tool. Prompt copy is the model-facing
 * contract; keep it stable.
 */

export const QUESTION_TOOL_NAME = "question";
export const QUESTION_LABEL = "Question";

// Mechanism plus the two rules the schema cannot state: the recommended-option
// convention, and the reserved/vague labels models reach for most often.
// Per-field authoring rules and limits live in QuestionParams.
export const QUESTION_DESCRIPTION =
	"Ask the user 1-4 structured multiple-choice questions and return their selections. Never author an 'Other'-style option or a vague label like 'Option A' — the UI adds a custom-answer path itself. If you recommend an option, put it first and append ' (Recommended)' to its label.";

export const QUESTION_PROMPT_SNIPPET =
	"Ask the user structured multiple-choice questions when blocked on a decision only they can make";

export const QUESTION_PROMPT_GUIDELINES = [
	"Use `question` only for decisions you cannot resolve from the request, the code, or sensible defaults (direction, preference, permissions, destructive choices); for everything else choose a reasonable default and state it.",
	"Batch related decisions into one `question` call (1-4 questions); ask no more than needed to unblock the next step.",
	"Treat `question` answers as decisions: act on them without re-litigating, and do not re-ask unless circumstances change.",
];
