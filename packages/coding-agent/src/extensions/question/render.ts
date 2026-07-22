import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { answerScalar } from "./results.ts";
import type { Question, QuestionToolDetails } from "./types.ts";

type RenderOptions = { expanded: boolean };

type ResultLike = {
	content: Array<{ type: string; text?: string }>;
	details?: QuestionToolDetails;
};

function questionsFromArgs(args: unknown): Question[] {
	if (!args || typeof args !== "object" || !("questions" in args) || !Array.isArray(args.questions)) return [];
	return args.questions.filter(
		(question): question is Question =>
			Boolean(question) &&
			typeof question === "object" &&
			"header" in question &&
			typeof question.header === "string",
	);
}

function resultFallback(result: ResultLike): string {
	return result.content
		.filter(
			(block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

export function renderQuestionCall(args: unknown, theme: Theme): Text {
	const questions = questionsFromArgs(args);
	const headers = questions.map((question) => question.header).join(", ");
	const count = `${questions.length} decision${questions.length === 1 ? "" : "s"}`;
	const summary = questions.length === 0 ? "asking for a decision" : headers ? `${count}: ${headers}` : count;
	return new Text(`${theme.fg("toolTitle", theme.bold("question"))} ${theme.fg("muted", summary)}`, 0, 0);
}

export function renderQuestionResult(result: ResultLike, options: RenderOptions, theme: Theme): Text {
	const details = result.details;
	if (!details) return new Text(resultFallback(result), 0, 0);

	if (details.outcome === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	if (details.outcome === "needs_clarification") {
		return new Text(theme.fg("warning", "Wants to discuss the choices before answering"), 0, 0);
	}
	if (details.outcome === "error") {
		return new Text(theme.fg("error", `Question error: ${details.error ?? "unknown error"}`), 0, 0);
	}

	const title = theme.fg(
		"success",
		`✓ Answered ${details.answers.length} decision${details.answers.length === 1 ? "" : "s"}`,
	);
	if (!options.expanded) return new Text(title, 0, 0);

	const answers = details.answers.map((answer) => {
		const notes = answer.notes?.length
			? `\n${answer.notes.map((note) => theme.fg("muted", `    Note for ${note.option}: ${note.text}`)).join("\n")}`
			: "";
		return `${theme.fg("accent", answer.header)}: ${theme.fg("text", answerScalar(answer))}${notes}`;
	});
	return new Text(`${title}\n${answers.join("\n")}`, 0, 0);
}
