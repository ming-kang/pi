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

	it("truncates oversized results and asks for a follow-up", () => {
		const result = successResult([answer({ answer: "x".repeat(QUESTION_LIMITS.modelResultChars * 2) })]);
		const text = textOf(result);
		expect(text.length).toBeLessThanOrEqual(QUESTION_LIMITS.modelResultChars);
		expect(text).toContain("[Question result truncated.");
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
