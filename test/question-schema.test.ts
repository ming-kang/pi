import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { QuestionParams, validateQuestions } from "../src/extensions/question/schema.ts";
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
