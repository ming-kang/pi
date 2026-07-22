import type { AgentToolResult } from "../../core/extensions/types.ts";
import { QUESTION_LIMITS, TRUNCATION_FOLLOW_UP } from "./limits.ts";
import type { QuestionAnswer, QuestionToolDetails, QuestionToolError } from "./types.ts";

const DECLINE_MESSAGE = "User declined to answer the questions.";
const CLARIFICATION_MESSAGE = "The user wants to discuss these questions before choosing an answer.";
const ENVELOPE_PREFIX = "User decisions:";
const ENVELOPE_SUFFIX = "Continue with these decisions in mind.";

function buildToolResult(text: string, details: QuestionToolDetails): AgentToolResult<QuestionToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function boundedText(text: string): string {
	if (text.length <= QUESTION_LIMITS.modelResultChars) return text;
	const suffix = `\n\n[Question result truncated. ${TRUNCATION_FOLLOW_UP}]`;
	return `${text.slice(0, Math.max(0, QUESTION_LIMITS.modelResultChars - suffix.length))}${suffix}`;
}

export function errorResult(error: QuestionToolError, message: string): AgentToolResult<QuestionToolDetails> {
	return buildToolResult(`Question tool error (${error}): ${message}`, {
		answers: [],
		outcome: "error",
		cancelled: false,
		error,
	});
}

export function answerScalar(answer: QuestionAnswer): string {
	if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "(no input)";
	return answer.answer && answer.answer.length > 0 ? answer.answer : "(no input)";
}

function answerKindLabel(answer: QuestionAnswer): string {
	if (answer.kind === "multi") return "Selections";
	return answer.kind === "custom" ? "Custom answer" : "Selected option";
}

function answerSegment(answer: QuestionAnswer): string {
	const lines = [
		`${answer.questionIndex + 1}. [${answer.header}] ${answer.question}`,
		`   ${answerKindLabel(answer)}: ${answerScalar(answer)}`,
	];
	if (answer.preview) lines.push("   Preview: selected (kept in tool details)");
	for (const note of answer.notes ?? []) lines.push(`   Note for ${note.option}: ${note.text}`);
	return lines.join("\n");
}

export function successResult(answers: QuestionAnswer[]): AgentToolResult<QuestionToolDetails> {
	const text = answers.length
		? boundedText(`${ENVELOPE_PREFIX}\n${answers.map(answerSegment).join("\n\n")}\n\n${ENVELOPE_SUFFIX}`)
		: DECLINE_MESSAGE;
	return buildToolResult(text, {
		answers,
		outcome: answers.length ? "answered" : "cancelled",
		cancelled: answers.length === 0,
	});
}

export function cancelResult(answers: QuestionAnswer[] = []): AgentToolResult<QuestionToolDetails> {
	return buildToolResult(DECLINE_MESSAGE, { answers, outcome: "cancelled", cancelled: true });
}

export function clarificationResult(answers: QuestionAnswer[] = []): AgentToolResult<QuestionToolDetails> {
	const answered = answers.length ? ` Partial answers so far:\n${answers.map(answerSegment).join("\n\n")}` : "";
	return buildToolResult(
		boundedText(
			`${CLARIFICATION_MESSAGE}${answered}\n\nExplain the trade-offs or ask what the user would like clarified.`,
		),
		{
			answers,
			outcome: "needs_clarification",
			cancelled: false,
		},
	);
}
