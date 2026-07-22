export interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

export interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export type InputMode = "custom" | "notes" | undefined;

export type QuestionToolError =
	| "no_ui"
	| "no_questions"
	| "too_many_questions"
	| "invalid_option_count"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "invalid_text_length";

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
}

export interface CustomAnswer {
	text: string;
	selected: boolean;
}

export interface QuestionState {
	optionIndex: number;
	singleAnswer?: QuestionAnswer;
	multiSelected: Set<number>;
	customAnswer?: CustomAnswer;
	notesByOption: Map<string, string>;
	warning?: string;
}

export interface DialogResult {
	answers: QuestionAnswer[];
	outcome: QuestionOutcome;
}

export type DisplayOption =
	| (QuestionOption & { kind: "option"; optionIndex: number })
	| { kind: "other"; label: string; isOther: true };

export const OTHER_OPTION: DisplayOption = { kind: "other", label: "Type something.", isOther: true };
