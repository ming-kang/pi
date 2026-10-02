import { describe, expect, it } from "vitest";
import { QUESTION_LIMITS } from "../src/extensions/question/limits.ts";
import { cancelResult, clarificationResult, errorResult, successResult } from "../src/extensions/question/results.ts";
import type { QuestionAnswer } from "../src/extensions/question/types.ts";

function answer(overrides?: Partial<QuestionAnswer>): QuestionAnswer {
	return {
		questionIndex: 0,
		question: "Which approach should we take?",
		header: "Approach",
		kind: "option",
		answer: "Alpha",
		...overrides,
	};
}

function textOf(result: ReturnType<typeof successResult>): string {
	return result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
}

describe("errorResult", () => {
	it("keeps the human-readable message in structured details for rendering", () => {
		const result = errorResult("preview_multiselect", "Option previews are not supported on multiSelect questions");
		expect(result.details?.error).toBe("preview_multiselect");
		expect(result.details?.message).toBe("Option previews are not supported on multiSelect questions");
	});
});

describe("successResult", () => {
	it("wraps answers in the decisions envelope", () => {
		const result = successResult([answer({ notes: [{ option: "Alpha", text: "prefer simple" }] })]);
		const text = textOf(result);
		expect(text).toContain("User decisions:");
		expect(text).toContain("1. [Approach] Which approach should we take?");
		expect(text).toContain("Selected option: Alpha");
		expect(text).toContain("Note for Alpha: prefer simple");
		expect(text).toContain("Continue with these decisions in mind.");
		expect(result.details?.outcome).toBe("answered");
	});

	it("treats an empty answer list as a decline", () => {
		const result = successResult([]);
		expect(textOf(result)).toBe("User declined to answer the questions.");
		expect(result.details?.cancelled).toBe(true);
	});

	it("leaves results within the limit untouched", () => {
		const text = textOf(successResult([answer({ notes: [{ option: "Alpha", text: "x".repeat(4_000) }] })]));
		expect(text).toContain("x".repeat(4_000));
		expect(text).not.toContain("truncated");
	});
});

describe("oversized results", () => {
	const long = (tag: string, filler = "x") =>
		`${tag}-START ${filler.repeat(QUESTION_LIMITS.userTextChars)} ${tag}-END`;
	const fourLongDecisions = () =>
		Array.from({ length: 4 }, (_, index) =>
			answer({
				questionIndex: index,
				question: `Question ${index + 1}?`,
				header: `Q${index + 1}`,
				kind: "multi",
				answer: null,
				selected: ["Alpha", long(`custom${index + 1}`)],
				notes: [{ option: "Alpha", text: long(`note${index + 1}`) }],
			}),
		);

	it("keeps every decision and the closing instruction while shortening long text", () => {
		const text = textOf(successResult(fourLongDecisions()));
		expect(text.length).toBeLessThanOrEqual(QUESTION_LIMITS.modelResultChars);
		for (let index = 1; index <= 4; index++) {
			expect(text).toContain(`${index}. [Q${index}] Question ${index}?`);
			expect(text).toContain(`Selections: Alpha, custom${index}-START`);
			expect(text).toContain(`custom${index}-END`);
			expect(text).toContain(`Note for Alpha: note${index}-START`);
			expect(text).toContain(`note${index}-END`);
		}
		expect(text).toContain("Continue with these decisions in mind.");
		expect(text).toMatch(/…\d+ chars truncated…/);
		expect(text).toContain("Ask the user a focused follow-up question");
	});

	it("keeps short notes whole and shortens long ones evenly", () => {
		const answers = fourLongDecisions();
		answers[0].notes = [{ option: "Alpha", text: "keep it simple" }];
		const text = textOf(successResult(answers));
		expect(text).toContain("Note for Alpha: keep it simple");
		const kept = [...text.matchAll(/note(\d)-START (x*)…/g)].map((match) => match[2].length);
		expect(kept).toHaveLength(3);
		expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(1);
	});

	it("stays within the limit without splitting multi-byte characters", () => {
		const answers = fourLongDecisions().map((entry, index) => ({
			...entry,
			notes: [{ option: "Alpha", text: long(`note${index + 1}`, "中文🙂") }],
		}));
		const text = textOf(successResult(answers));
		expect(text.length).toBeLessThanOrEqual(QUESTION_LIMITS.modelResultChars);
		expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
		expect(text).not.toContain("�");
		expect(text).toContain("note4-END");
	});

	it("bounds partial answers in cancelled and clarification results", () => {
		for (const result of [cancelResult(fourLongDecisions()), clarificationResult(fourLongDecisions())]) {
			const text = textOf(result);
			expect(text.length).toBeLessThanOrEqual(QUESTION_LIMITS.modelResultChars);
			expect(text).toContain("4. [Q4] Question 4?");
			expect(text).toMatch(/…\d+ chars truncated…/);
		}
	});
});

describe("cancelResult", () => {
	it("returns the plain decline message when nothing was answered", () => {
		const result = cancelResult([]);
		expect(textOf(result)).toBe("User declined to answer the questions.");
		expect(result.details?.outcome).toBe("cancelled");
	});

	it("includes partial answers given before cancelling", () => {
		const result = cancelResult([answer()]);
		const text = textOf(result);
		expect(text).toContain("User declined to answer the questions.");
		expect(text).toContain("Partial answers so far:");
		expect(text).toContain("Selected option: Alpha");
		expect(result.details?.answers).toHaveLength(1);
	});
});

describe("clarificationResult", () => {
	it("surfaces partial answers and prompts discussion", () => {
		const result = clarificationResult([answer()]);
		const text = textOf(result);
		expect(text).toContain("wants to discuss");
		expect(text).toContain("Selected option: Alpha");
		expect(result.details?.outcome).toBe("needs_clarification");
	});
});
