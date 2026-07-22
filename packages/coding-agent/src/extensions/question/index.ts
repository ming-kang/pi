/**
 * question — ask the user structured questions during execution.
 *
 * This is a Pi-native AskUserQuestion-style tool. It keeps the UI lightweight
 * while returning a structured result envelope the model can reliably consume.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	QUESTION_DESCRIPTION,
	QUESTION_LABEL,
	QUESTION_PROMPT_GUIDELINES,
	QUESTION_PROMPT_SNIPPET,
	QUESTION_TOOL_NAME,
} from "./constants.ts";
import { createQuestionDialog } from "./dialog.ts";
import { renderQuestionCall, renderQuestionResult } from "./render.ts";
import { cancelResult, clarificationResult, errorResult, successResult } from "./results.ts";
import { QuestionParams, validateQuestions } from "./schema.ts";
import type { DialogResult, Question } from "./types.ts";

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: QUESTION_TOOL_NAME,
		label: QUESTION_LABEL,
		description: QUESTION_DESCRIPTION,
		promptSnippet: QUESTION_PROMPT_SNIPPET,
		promptGuidelines: QUESTION_PROMPT_GUIDELINES,
		parameters: QuestionParams,
		renderCall: renderQuestionCall,
		renderResult: renderQuestionResult,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as Question[];
			if (!ctx.hasUI || ctx.mode !== "tui") return errorResult("no_ui", "question tool requires an interactive TUI");

			const validation = validateQuestions(questions);
			if (!validation.ok) return errorResult(validation.error, validation.message);

			const result = await ctx.ui.custom<DialogResult>(createQuestionDialog(questions));
			if (result.outcome === "cancelled") return cancelResult(result.answers);
			if (result.outcome === "needs_clarification") return clarificationResult(result.answers);
			return successResult(result.answers);
		},
	});
}
