import { describe, expect, it } from "vitest";
import { validateQuestions } from "../src/extensions/question/schema.ts";
import type { Question, QuestionOption } from "../src/extensions/question/types.ts";

function option(label: string, extra?: Partial<QuestionOption>): QuestionOption {
	return { label, description: `${label} description`, ...extra };
}

function question(overrides?: Partial<Question>): Question {
	return {
		question: "Which approach should we take?",
		header: "Approach",
		options: [option("Alpha"), option("Beta")],
		...overrides,
	};
}

describe("validateQuestions", () => {
	it("accepts a well-formed question", () => {
		expect(validateQuestions([question()])).toEqual({ ok: true });
	});

	it("rejects reserved labels exactly", () => {
		const result = validateQuestions([question({ options: [option("Other"), option("Beta")] })]);
		expect(result).toMatchObject({ ok: false, error: "reserved_label" });
	});

	it("rejects reserved labels case-insensitively and ignoring padding", () => {
		for (const label of ["OTHER", " other ", "type something", "Type something.", "Chat About This"]) {
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
