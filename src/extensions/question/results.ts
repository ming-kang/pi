import type { AgentToolResult } from "../../core/extensions/types.ts";
import { truncateMiddle } from "../../core/tools/truncate.ts";
import { QUESTION_LIMITS, TRUNCATION_FOLLOW_UP } from "./limits.ts";
import type { QuestionAnswer, QuestionToolDetails, QuestionToolError } from "./types.ts";

const DECLINE_MESSAGE = "User declined to answer the questions.";
const CLARIFICATION_MESSAGE = "The user wants to discuss these questions before choosing an answer.";
const ENVELOPE_PREFIX = "User decisions:";
const ENVELOPE_SUFFIX = "Continue with these decisions in mind.";
const CLARIFICATION_FOLLOW_UP = "Explain the trade-offs or ask what the user would like clarified.";
const SHORTENED_NOTICE = `\n\n[Long answers or notes were shortened where marked "chars truncated". ${TRUNCATION_FOLLOW_UP}]`;

function buildToolResult(text: string, details: QuestionToolDetails): AgentToolResult<QuestionToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Largest per-text length that fits `budget`: short texts stay whole, long ones share what remains equally. */
function fairShare(lengths: number[], budget: number): number {
	const sorted = [...lengths].sort((a, b) => a - b);
	let remaining = budget;
	for (let index = 0; index < sorted.length; index++) {
		const share = Math.floor(remaining / (sorted.length - index));
		if (sorted[index] > share) return Math.max(0, share);
		remaining -= sorted[index];
	}
	return Number.POSITIVE_INFINITY;
}

/** Keep the start and end of `text` within `cap` characters. */
function shorten(text: string, cap: number): string {
	if (text.length <= cap) return text;
	// A UTF-16 length never exceeds the UTF-8 byte count, so a byte budget bounds characters too.
	const marker = `…${text.length} chars truncated…`;
	return truncateMiddle(text, Math.max(0, cap - marker.length)).content;
}

/**
 * Fit answers inside `envelope` to the model-facing limit. Question lines, headers, and
 * the envelope always stay whole; only user-written text (answers, selections, notes) is
 * shortened, evenly and in place. The input limits keep the fixed parts well below the cap.
 */
function boundedAnswers(answers: QuestionAnswer[], envelope: (body: string) => string): string {
	const full = envelope(answers.map((answer) => answerSegment(answer, (text) => text)).join("\n\n"));
	if (full.length <= QUESTION_LIMITS.modelResultChars) return full;

	const lengths: number[] = [];
	for (const answer of answers) {
		answerSegment(answer, (text) => {
			lengths.push(text.length);
			return text;
		});
	}
	const fixed = full.length - lengths.reduce((sum, length) => sum + length, 0) + SHORTENED_NOTICE.length;
	const cap = fairShare(lengths, QUESTION_LIMITS.modelResultChars - fixed);
	const body = answers.map((answer) => answerSegment(answer, (text) => shorten(text, cap))).join("\n\n");
	return `${envelope(body)}${SHORTENED_NOTICE}`;
}

export function errorResult(error: QuestionToolError, message: string): AgentToolResult<QuestionToolDetails> {
	return buildToolResult(`Question tool error (${error}): ${message}`, {
		answers: [],
		outcome: "error",
		cancelled: false,
		error,
		message,
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

/** Format one answer; `shape` receives each piece of user-written text and may shorten it. */
function answerSegment(answer: QuestionAnswer, shape: (text: string) => string): string {
	const response =
		answer.kind === "multi" && answer.selected?.length
			? answer.selected.map(shape).join(", ")
			: shape(answerScalar(answer));
	const lines = [
		`${answer.questionIndex + 1}. [${answer.header}] ${answer.question}`,
		`   ${answerKindLabel(answer)}: ${response}`,
	];
	if (answer.preview) lines.push("   Preview: selected (kept in tool details)");
	for (const note of answer.notes ?? []) lines.push(`   Note for ${note.option}: ${shape(note.text)}`);
	return lines.join("\n");
}

export function successResult(answers: QuestionAnswer[]): AgentToolResult<QuestionToolDetails> {
	const text = answers.length
		? boundedAnswers(answers, (body) => `${ENVELOPE_PREFIX}\n${body}\n\n${ENVELOPE_SUFFIX}`)
		: DECLINE_MESSAGE;
	return buildToolResult(text, {
		answers,
		outcome: answers.length ? "answered" : "cancelled",
		cancelled: answers.length === 0,
	});
}

export function cancelResult(answers: QuestionAnswer[] = []): AgentToolResult<QuestionToolDetails> {
	const text = answers.length
		? boundedAnswers(answers, (body) => `${DECLINE_MESSAGE}\n\nPartial answers so far:\n${body}`)
		: DECLINE_MESSAGE;
	return buildToolResult(text, {
		answers,
		outcome: "cancelled",
		cancelled: true,
	});
}

export function clarificationResult(answers: QuestionAnswer[] = []): AgentToolResult<QuestionToolDetails> {
	const envelope = (body: string) =>
		`${CLARIFICATION_MESSAGE}${body ? ` Partial answers so far:\n${body}` : ""}\n\n${CLARIFICATION_FOLLOW_UP}`;
	return buildToolResult(answers.length ? boundedAnswers(answers, envelope) : envelope(""), {
		answers,
		outcome: "needs_clarification",
		cancelled: false,
	});
}
