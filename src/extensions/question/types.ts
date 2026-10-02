import type { QuestionOption } from "./schema.ts";

export type { Question, QuestionOption } from "./schema.ts";

export type QuestionToolError =
	| "no_ui"
	| "blank_text"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "preview_multiselect";

export interface AnswerNote {
	option: string;
	text: string;
}

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	header: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: AnswerNote[];
	preview?: string;
}

export type QuestionOutcome = "answered" | "cancelled" | "needs_clarification" | "error";

export interface QuestionToolDetails {
	answers: QuestionAnswer[];
	outcome: QuestionOutcome;
	cancelled: boolean;
	error?: QuestionToolError;
	message?: string;
}

/** A single-select choice: an authored option by index, or the user's own text. */
export type SingleChoice = { kind: "option"; index: number } | { kind: "custom"; text: string };

export interface CustomAnswer {
	text: string;
	selected: boolean;
}

export type AnswerDraft =
	| { kind: "single"; choice?: SingleChoice }
	| { kind: "multi"; selected: Set<number>; custom?: CustomAnswer };

export interface QuestionState {
	/** Index of the focused row in `displayOptions()`. */
	focus: number;
	draft: AnswerDraft;
	/** Notes keyed by authored option index. */
	notes: Map<number, string>;
	warning?: string;
}

/**
 * What the dialog is doing. A single-select notes session tentatively selects
 * its option, so it remembers the choice to restore when left without saving.
 */
export type DialogMode =
	| { kind: "choose" }
	| { kind: "chat" }
	| { kind: "custom" }
	| { kind: "notes"; option: number; previous: SingleChoice | undefined }
	| { kind: "review" };

export interface DialogResult {
	answers: QuestionAnswer[];
	outcome: Exclude<QuestionOutcome, "error">;
}

export type DisplayOption =
	| (QuestionOption & { kind: "option"; optionIndex: number })
	| { kind: "other"; label: string };

export const OTHER_OPTION: DisplayOption = { kind: "other", label: "Type something" };
