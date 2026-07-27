import { describe, expect, it } from "vitest";
import { renderQuestionCall, renderQuestionResult } from "../src/extensions/question/render.ts";
import type { QuestionAnswer, QuestionToolDetails } from "../src/extensions/question/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const args = {
	questions: [
		{
			header: "Approach",
			question: "Which approach should we take?",
			multiSelect: false,
			options: [],
		},
		{
			header: "Features",
			question: "Which features should ship together?",
			multiSelect: true,
			options: [],
		},
	],
};

function answer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
	return {
		questionIndex: 0,
		question: "Which approach should we take?",
		header: "Approach",
		kind: "option",
		answer: "Alpha",
		...overrides,
	};
}

function result(details: QuestionToolDetails, text = "result") {
	return { content: [{ type: "text", text }], details };
}

function rendered(component: ReturnType<typeof renderQuestionResult>): string {
	return component.render(200).join("\n");
}

describe("question rendering", () => {
	it("keeps the collapsed call concise and lists full questions when expanded", () => {
		const collapsed = renderQuestionCall(args, theme, false).render(200).join("\n");
		expect(collapsed).toContain("question 2 decisions: Approach, Features");
		expect(collapsed).not.toContain("Which approach should we take?");

		const expanded = renderQuestionCall(args, theme, true).render(200).join("\n");
		expect(expanded).toContain("Approach: Which approach should we take?");
		expect(expanded).toContain("Features (multi-select): Which features should ship together?");

		const emptyHeader = renderQuestionCall(
			{ questions: [{ header: "", question: "Can an empty schema-valid header still render?" }] },
			theme,
			true,
		)
			.render(200)
			.join("\n");
		expect(emptyHeader).toContain("question 1 decision: Decision 1");
		expect(emptyHeader).toContain("Decision 1: Can an empty schema-valid header still render?");
	});

	it("shows cancellation progress and partial answers only when expanded", () => {
		const details: QuestionToolDetails = {
			answers: [answer({ notes: [{ option: "Alpha", text: "Prefer the simpler path" }] })],
			outcome: "cancelled",
			cancelled: true,
		};
		const collapsed = rendered(renderQuestionResult(result(details), { expanded: false }, theme, args));
		expect(collapsed).toContain("Cancelled · answered 1 of 2");
		expect(collapsed).not.toContain("Approach: Alpha");

		const expanded = rendered(renderQuestionResult(result(details), { expanded: true }, theme, args));
		expect(expanded).toContain("Cancelled · answered 1 of 2");
		expect(expanded).toContain("Approach: Alpha");
		expect(expanded).toContain("Note for Alpha: Prefer the simpler path");
	});

	it("keeps all four multi-select options plus a custom answer", () => {
		const details: QuestionToolDetails = {
			answers: [
				answer({
					header: "Features",
					kind: "multi",
					answer: null,
					selected: ["Alpha", "Beta", "Gamma", "Delta", "Custom requirement"],
				}),
			],
			outcome: "answered",
			cancelled: false,
		};
		const output = rendered(renderQuestionResult(result(details), { expanded: true }, theme, args));
		expect(output).toContain("Features: Alpha, Beta, Gamma, Delta, Custom requirement");
	});

	it("shows clarification progress and its partial answers", () => {
		const details: QuestionToolDetails = {
			answers: [answer()],
			outcome: "needs_clarification",
			cancelled: false,
		};
		const output = rendered(renderQuestionResult(result(details), { expanded: true }, theme, args));
		expect(output).toContain("Wants to discuss · answered 1 of 2");
		expect(output).toContain("Approach: Alpha");
	});

	it("collapses schema validation failures and expands the bounded raw details", () => {
		const invalid = {
			content: [
				{
					type: "text",
					text: [
						'Validation failed for tool "question":',
						"  - questions.0.question: must have required properties question",
						"  - questions.0.options: must have at least 2 items",
						"",
						"Received arguments:",
						'{ "questions": [{ "header": "Testing" }] }',
					].join("\n"),
				},
			],
		};

		const collapsed = rendered(renderQuestionResult(invalid, { expanded: false }, theme, args));
		expect(collapsed).toContain("Invalid arguments · questions.0.question: must have required properties question");
		expect(collapsed).toContain("+1 more");
		expect(collapsed).toMatch(/to expand|more details available/u);
		expect(collapsed).not.toContain("Received arguments");
		expect(collapsed).not.toContain('"header": "Testing"');

		const expanded = rendered(renderQuestionResult(invalid, { expanded: true }, theme, args));
		expect(expanded).toContain('Validation failed for tool "question"');
		expect(expanded).toContain("questions.0.options: must have at least 2 items");
		expect(expanded).toContain("Received arguments:");
		expect(expanded).toContain('"header": "Testing"');
		expect(expanded).not.toContain("to expand");
	});

	it("defensively bounds malformed historical details", () => {
		const malformed = {
			content: [{ type: "text", text: "Question tool error (no_ui): interactive UI required" }],
			details: { outcome: "error", answers: "not-an-array", message: { bad: true } },
		};
		const malformedOutput = rendered(renderQuestionResult(malformed, { expanded: true }, theme, args));
		expect(malformedOutput).toContain("Question error: interactive UI required");

		const oversized = {
			content: [{ type: "text", text: "error" }],
			details: { outcome: "error", answers: [], message: "x".repeat(2_000) },
		};
		const oversizedOutput = rendered(renderQuestionResult(oversized, { expanded: false }, theme, args));
		expect(oversizedOutput).toContain("…");
		expect(oversizedOutput).not.toContain("x".repeat(500));
	});

	it("renders human-readable errors without exposing machine codes", () => {
		const details: QuestionToolDetails = {
			answers: [],
			outcome: "error",
			cancelled: false,
			error: "preview_multiselect",
			message: "Option previews are unavailable for multi-select questions",
		};
		const output = rendered(renderQuestionResult(result(details), { expanded: false }, theme, args));
		expect(output).toContain("Question error: Option previews are unavailable for multi-select questions");
		expect(output).not.toContain("preview_multiselect");

		const historical = rendered(
			renderQuestionResult(
				result(
					{ answers: [], outcome: "error", cancelled: false, error: "reserved_label" },
					"Question tool error (reserved_label): Option label is reserved",
				),
				{ expanded: false },
				theme,
				args,
			),
		);
		expect(historical).toContain("Question error: Option label is reserved");
		expect(historical).not.toContain("reserved_label");
	});
});
