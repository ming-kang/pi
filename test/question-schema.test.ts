import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { normalizeQuestionArguments, QuestionParams, validateQuestions } from "../src/extensions/question/schema.ts";
import type { Question, QuestionOption } from "../src/extensions/question/types.ts";

function option(label: string, extra?: Partial<QuestionOption>): QuestionOption {
	return { label, description: `${label} description`, ...extra };
}

const validateSchema = Compile(QuestionParams);

function question(overrides?: Partial<Question>): Question {
	return {
		question: "Which approach should we take?",
		header: "Approach",
		options: [option("Alpha"), option("Beta")],
		...overrides,
	};
}

describe("validateQuestions", () => {
	it("expresses non-empty visible strings in the TypeBox schema", () => {
		expect(validateSchema.Check({ questions: [question()] })).toBe(true);
		for (const invalid of [
			question({ question: "" }),
			question({ header: "" }),
			question({ options: [option(""), option("Beta")] }),
			question({ options: [option("Alpha", { description: "" }), option("Beta")] }),
			question({ options: [option("Alpha", { preview: "" }), option("Beta")] }),
		]) {
			expect(validateSchema.Check({ questions: [invalid] })).toBe(false);
		}
	});

	it("defensively rejects whitespace-only visible text with a path-specific error", () => {
		const cases: Array<{ value: Question; path: string }> = [
			{ value: question({ question: "   " }), path: "questions[0].question" },
			{ value: question({ header: "\t" }), path: "questions[0].header" },
			{
				value: question({ options: [option("   "), option("Beta")] }),
				path: "questions[0].options[0].label",
			},
			{
				value: question({ options: [option("Alpha", { description: "\n" }), option("Beta")] }),
				path: "questions[0].options[0].description",
			},
			{
				value: question({ options: [option("Alpha", { preview: " \n " }), option("Beta")] }),
				path: "questions[0].options[0].preview",
			},
		];
		for (const testCase of cases) {
			const result = validateQuestions([testCase.value]);
			expect(result).toMatchObject({ ok: false, error: "blank_text" });
			if (!result.ok) expect(result.message).toContain(testCase.path);
		}
	});

	it("does not require question-mark punctuation", () => {
		expect(validateQuestions([question({ question: "Choose the deployment target" })])).toEqual({ ok: true });
	});

	it("accepts a well-formed question", () => {
		expect(validateQuestions([question()])).toEqual({ ok: true });
	});

	it("rejects reserved labels case-insensitively and ignoring padding", () => {
		for (const label of ["Other", "OTHER", " other ", "type something", "Type something.", "Chat About This"]) {
			const result = validateQuestions([question({ options: [option(label), option("Beta")] })]);
			expect(result, label).toMatchObject({ ok: false, error: "reserved_label" });
		}
	});

	it("allows 'Next' as a label (no longer reserved)", () => {
		expect(validateQuestions([question({ options: [option("Next"), option("Beta")] })])).toEqual({ ok: true });
	});

	it("rejects duplicate option labels case-insensitively and ignoring padding", () => {
		const result = validateQuestions([question({ options: [option("Alpha"), option(" alpha ")] })]);
		expect(result).toMatchObject({ ok: false, error: "duplicate_option_label" });
	});

	it("rejects duplicate question text case-insensitively", () => {
		const result = validateQuestions([
			question(),
			question({ question: "which approach should we take?", header: "Approach 2" }),
		]);
		expect(result).toMatchObject({ ok: false, error: "duplicate_question" });
	});

	it("rejects previews on multiSelect questions", () => {
		const result = validateQuestions([
			question({
				multiSelect: true,
				options: [option("Alpha", { preview: "```ts\nconst a = 1\n```" }), option("Beta")],
			}),
		]);
		expect(result).toMatchObject({ ok: false, error: "preview_multiselect" });
	});

	it("allows previews on single-select questions", () => {
		const result = validateQuestions([
			question({ options: [option("Alpha", { preview: "```ts\nconst a = 1\n```" }), option("Beta")] }),
		]);
		expect(result).toEqual({ ok: true });
	});
});

describe("normalizeQuestionArguments", () => {
	it("wraps a lone question written flat at the root", () => {
		expect(
			normalizeQuestionArguments({
				question: "Which approach?",
				header: "Approach",
				options: [option("Alpha"), option("Beta")],
			}),
		).toEqual({ questions: [question({ question: "Which approach?", header: "Approach" })] });
	});

	it("carries multiSelect into the wrapped question", () => {
		expect(
			normalizeQuestionArguments({
				question: "Which approaches?",
				header: "Approach",
				options: [option("Alpha"), option("Beta")],
				multiSelect: true,
			}),
		).toEqual({
			questions: [question({ question: "Which approaches?", header: "Approach", multiSelect: true })],
		});
	});

	it("fills a questions[0] that lost its question field to the root", () => {
		expect(
			normalizeQuestionArguments({
				question: "Which approach?",
				questions: [{ header: "Approach", options: [option("Alpha"), option("Beta")] }],
			}),
		).toEqual({ questions: [question({ question: "Which approach?", header: "Approach" })] });
	});

	it("parses a stringified questions array and leaves broken JSON for validation", () => {
		const valid = normalizeQuestionArguments({
			questions: JSON.stringify([question({ question: "Which approach?" })]),
		});
		expect(validateSchema.Check(valid)).toBe(true);

		const broken = normalizeQuestionArguments({ questions: "[{not json" });
		expect(broken).toEqual({ questions: "[{not json" });
		expect(validateSchema.Check(broken)).toBe(false);
	});

	it("leaves ambiguous or well-formed shapes untouched", () => {
		// Well-formed arguments pass through unchanged.
		const wellFormed = { questions: [question()] };
		expect(normalizeQuestionArguments(wellFormed)).toEqual(wellFormed);
		// A root question without options is not enough to wrap.
		expect(normalizeQuestionArguments({ question: "Which approach?" })).toEqual({
			question: "Which approach?",
		});
		// A root question alongside two full questions is left for validation.
		const twoQuestions = { question: "stray", questions: [question(), question({ question: "Another?" })] };
		expect(normalizeQuestionArguments(twoQuestions)).toEqual(twoQuestions);
		// Non-object arguments pass through for validation to reject.
		expect(normalizeQuestionArguments(null)).toBeNull();
		expect(normalizeQuestionArguments("nope")).toBe("nope");
	});
});

describe("question strict constrained sampling", () => {
	it("keeps the schema inside the strict subset", () => {
		expect(() => makeStrictJsonSchema(QuestionParams)).not.toThrow();
	});
});
