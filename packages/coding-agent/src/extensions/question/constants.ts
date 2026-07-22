/**
 * constants.ts — question tool identity + prompt copy.
 *
 * Name/label/description/promptSnippet/promptGuidelines live here so
 * `index.ts` only assembles the tool. Prompt copy is the model-facing
 * contract; keep it stable.
 */

export const QUESTION_TOOL_NAME = "question";
export const QUESTION_LABEL = "Question";

export const QUESTION_DESCRIPTION =
	"Ask the user 1-4 structured multiple-choice questions. Use it only when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or sensible defaults: product direction, subjective preference, credentials/permissions, or destructive/irreversible choices. For low-risk details, pick a reasonable default yourself and state it instead. Write each question as one concrete decision ending in a question mark, with a short header and 2-4 mutually distinct options. Every option must have a concise description explaining its consequence or trade-off; never author vague labels ('Option A') or an 'Other'-style option — the UI adds a custom-answer path automatically. If you recommend an option, put it first and append ' (Recommended)' to its label. Use multiSelect only when options can validly be combined. Use option previews only for concrete artifacts the user must visually compare (code snippets, UI mockups, copy or config variants); previews render for single-select questions only.";

export const QUESTION_PROMPT_SNIPPET =
	"Ask the user structured multiple-choice questions when blocked on a decision only they can make (preference, direction, permissions, destructive choices)";

export const QUESTION_PROMPT_GUIDELINES = [
	"Use `question` only for decisions you cannot resolve from the request, the code, or sensible defaults (direction, preference, permissions, destructive choices); for everything else choose a reasonable default and state it.",
	"Batch related decisions into one `question` call (1-4 questions); ask no more than needed to unblock the next step.",
	"Treat `question` answers as decisions: act on them without re-litigating, and do not re-ask unless circumstances change.",
];
