export const QUESTION_LIMITS = {
	questionChars: 400,
	headerChars: 32,
	optionLabelChars: 80,
	optionDescriptionChars: 300,
	previewChars: 8_000,
	userTextChars: 4_000,
	modelResultChars: 12_000,
} as const;

export const TRUNCATION_FOLLOW_UP = "Ask the user a focused follow-up question to clarify the omitted portion.";
