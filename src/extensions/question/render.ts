import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { QUESTION_LIMITS } from "./limits.ts";
import { answerScalar } from "./results.ts";
import type { QuestionAnswer, QuestionOutcome } from "./types.ts";

type RenderOptions = { expanded: boolean };

type ResultLike = {
	content?: unknown;
	details?: unknown;
};

interface RenderQuestion {
	header: string;
	question: string;
	multiSelect: boolean;
}

interface RenderDetails {
	answers: QuestionAnswer[];
	outcome: QuestionOutcome;
	message?: string;
}

const MAX_RENDERED_QUESTIONS = 4;
const MAX_RENDERED_ANSWERS = 4;
const MAX_RENDERED_SELECTIONS = 5;
const MAX_RENDERED_ANSWER_CHARS = 400;
const MAX_RENDERED_NOTE_CHARS = 400;
const MAX_RENDERED_ERROR_CHARS = 400;
const MAX_RENDERED_FALLBACK_CHARS = 1_000;

function safeRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeValue(record: Record<string, unknown>, key: string): unknown {
	try {
		return record[key];
	} catch {
		return undefined;
	}
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function oneLine(value: unknown, limit: number): string {
	return typeof value === "string" ? truncate(value.replace(/\s+/gu, " ").trim(), limit) : "";
}

function questionsFromArgs(args: unknown): RenderQuestion[] {
	const record = safeRecord(args);
	if (!record) return [];
	const rawQuestions = safeValue(record, "questions");
	if (!Array.isArray(rawQuestions)) return [];
	const questions: RenderQuestion[] = [];
	for (const rawQuestion of rawQuestions.slice(0, MAX_RENDERED_QUESTIONS)) {
		const question = safeRecord(rawQuestion);
		if (!question) continue;
		const rawHeader = safeValue(question, "header");
		if (typeof rawHeader !== "string") continue;
		const header = oneLine(rawHeader, QUESTION_LIMITS.headerChars) || `Decision ${questions.length + 1}`;
		questions.push({
			header,
			question: oneLine(safeValue(question, "question"), QUESTION_LIMITS.questionChars),
			multiSelect: safeValue(question, "multiSelect") === true,
		});
	}
	return questions;
}

function resultFallback(result: ResultLike): string {
	if (!Array.isArray(result.content)) return "";
	const blocks: string[] = [];
	for (const rawBlock of result.content.slice(0, 8)) {
		const block = safeRecord(rawBlock);
		if (!block || safeValue(block, "type") !== "text") continue;
		const text = safeValue(block, "text");
		if (typeof text === "string") blocks.push(text);
	}
	return truncate(blocks.join("\n"), MAX_RENDERED_FALLBACK_CHARS);
}

function normalizeAnswer(value: unknown, index: number): QuestionAnswer | undefined {
	const raw = safeRecord(value);
	if (!raw) return undefined;
	const rawHeader = safeValue(raw, "header");
	if (typeof rawHeader !== "string") return undefined;
	const header = oneLine(rawHeader, QUESTION_LIMITS.headerChars) || `Decision ${index + 1}`;
	const kindValue = safeValue(raw, "kind");
	const kind = kindValue === "multi" || kindValue === "custom" ? kindValue : "option";
	const rawIndex = safeValue(raw, "questionIndex");
	const questionIndex =
		typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 0 ? rawIndex : index;
	const question = oneLine(safeValue(raw, "question"), QUESTION_LIMITS.questionChars);
	const answer = oneLine(safeValue(raw, "answer"), MAX_RENDERED_ANSWER_CHARS);

	const rawSelected = safeValue(raw, "selected");
	const selected = Array.isArray(rawSelected)
		? rawSelected
				.slice(0, MAX_RENDERED_SELECTIONS)
				.map((entry, selectedIndex) => {
					if (typeof entry !== "string") return "";
					return oneLine(entry, MAX_RENDERED_ANSWER_CHARS) || `Option ${selectedIndex + 1}`;
				})
				.filter(Boolean)
		: undefined;
	const rawNotes = safeValue(raw, "notes");
	const notes = Array.isArray(rawNotes)
		? rawNotes
				.slice(0, MAX_RENDERED_ANSWERS)
				.map((entry) => {
					const note = safeRecord(entry);
					if (!note) return undefined;
					const option = oneLine(safeValue(note, "option"), QUESTION_LIMITS.optionLabelChars);
					const text = oneLine(safeValue(note, "text"), MAX_RENDERED_NOTE_CHARS);
					return option && text ? { option, text } : undefined;
				})
				.filter((note): note is { option: string; text: string } => note !== undefined)
		: undefined;

	return {
		questionIndex,
		question,
		header,
		kind,
		answer: answer || null,
		...(kind === "multi" && selected?.length ? { selected } : {}),
		...(notes?.length ? { notes } : {}),
	};
}

function normalizeDetails(value: unknown): RenderDetails | undefined {
	const raw = safeRecord(value);
	if (!raw) return undefined;
	const outcome = safeValue(raw, "outcome");
	if (outcome !== "answered" && outcome !== "cancelled" && outcome !== "needs_clarification" && outcome !== "error") {
		return undefined;
	}
	const rawAnswers = safeValue(raw, "answers");
	const answers = Array.isArray(rawAnswers)
		? rawAnswers
				.slice(0, MAX_RENDERED_ANSWERS)
				.map((answer, index) => normalizeAnswer(answer, index))
				.filter((answer): answer is QuestionAnswer => answer !== undefined)
		: [];
	const message = oneLine(safeValue(raw, "message"), MAX_RENDERED_ERROR_CHARS);
	return { answers, outcome, ...(message ? { message } : {}) };
}

function errorMessage(result: ResultLike, details: RenderDetails): string {
	if (details.message) return details.message;
	const fallback = resultFallback(result).trim();
	const match = /^Question tool error \([^)]*\):\s*([\s\S]+)$/u.exec(fallback);
	return truncate(match?.[1]?.trim() || "The question tool could not continue", MAX_RENDERED_ERROR_CHARS);
}

function answerLines(answers: QuestionAnswer[], theme: Theme): string[] {
	return answers.map((answer) => {
		const notes = answer.notes?.length
			? `\n${answer.notes.map((note) => theme.fg("muted", `    Note for ${note.option}: ${note.text}`)).join("\n")}`
			: "";
		return `${theme.fg("accent", answer.header)}: ${theme.fg("text", answerScalar(answer))}${notes}`;
	});
}

function renderOutcome(title: string, details: RenderDetails, expanded: boolean, theme: Theme): Text {
	if (!expanded || details.answers.length === 0) return new Text(title, 0, 0);
	return new Text(`${title}\n${answerLines(details.answers, theme).join("\n")}`, 0, 0);
}

function answerProgress(details: RenderDetails, args: unknown): string {
	const total = questionsFromArgs(args).length;
	return total > 0 ? `answered ${details.answers.length} of ${total}` : `answered ${details.answers.length}`;
}

export function renderQuestionCall(args: unknown, theme: Theme, expanded: boolean): Text {
	const questions = questionsFromArgs(args);
	const headers = questions.map((question) => question.header).join(", ");
	const count = `${questions.length} decision${questions.length === 1 ? "" : "s"}`;
	const summary = questions.length === 0 ? "asking for a decision" : headers ? `${count}: ${headers}` : count;
	const title = `${theme.fg("toolTitle", theme.bold("question"))} ${theme.fg("muted", summary)}`;
	if (!expanded || questions.length === 0) return new Text(title, 0, 0);
	const detailLines = questions.map((question) => {
		const multi = question.multiSelect ? " (multi-select)" : "";
		const body = question.question ? `: ${question.question}` : "";
		return theme.fg("dim", `${question.header}${multi}${body}`);
	});
	return new Text(`${title}\n${detailLines.join("\n")}`, 0, 0);
}

export function renderQuestionResult(result: ResultLike, options: RenderOptions, theme: Theme, args?: unknown): Text {
	const details = normalizeDetails(result.details);
	if (!details) return new Text(resultFallback(result) || "Question result unavailable", 0, 0);

	if (details.outcome === "error") {
		return new Text(theme.fg("error", `Question error: ${errorMessage(result, details)}`), 0, 0);
	}
	if (details.outcome === "cancelled") {
		const title = theme.fg("warning", `Cancelled · ${answerProgress(details, args)}`);
		return renderOutcome(title, details, options.expanded, theme);
	}
	if (details.outcome === "needs_clarification") {
		const title = theme.fg("warning", `Wants to discuss · ${answerProgress(details, args)}`);
		return renderOutcome(title, details, options.expanded, theme);
	}

	const title = theme.fg(
		"success",
		`✓ Answered ${details.answers.length} decision${details.answers.length === 1 ? "" : "s"}`,
	);
	return renderOutcome(title, details, options.expanded, theme);
}
