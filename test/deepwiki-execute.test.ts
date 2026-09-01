import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWikiResponse } from "../src/extensions/deepwiki/client.ts";
import { DEEPWIKI_OUTPUT_CHAR_BUDGET, executeDeepWiki } from "../src/extensions/deepwiki/execute.ts";

const callDeepWikiMock = vi.hoisted(() => vi.fn());
vi.mock("../src/extensions/deepwiki/client.ts", () => ({ callDeepWiki: callDeepWikiMock }));

function response(text: string, toolName: DeepWikiResponse["toolName"]): DeepWikiResponse {
	return { toolName, text, outputLength: text.length };
}

function textOf(result: Awaited<ReturnType<typeof executeDeepWiki>>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

beforeEach(() => callDeepWikiMock.mockReset());

describe("executeDeepWiki output bounds", () => {
	it.each([
		["structure", "read_wiki_structure"],
		["question", "ask_question"],
	] as const)("hard-bounds %s output with an action-specific notice", async (action, toolName) => {
		const fullText = "x".repeat(DEEPWIKI_OUTPUT_CHAR_BUDGET + 10_000);
		callDeepWikiMock.mockResolvedValue(response(fullText, toolName));
		const result = await executeDeepWiki(
			action === "question"
				? { action, repoName: "phase4/output-bound", question: "How?" }
				: { action, repoName: "phase4/output-bound" },
			undefined,
			undefined,
		);
		const text = textOf(result);
		expect(text.length).toBeLessThanOrEqual(DEEPWIKI_OUTPUT_CHAR_BUDGET);
		expect(text).toContain(`[DeepWiki ${action} output truncated`);
		expect(result.details.outputLength).toBe(fullText.length);
		expect(result.details.truncatedChars).toBeGreaterThan(0);
	});

	it("truncates full contents at page boundaries while preserving the page-aware notice", async () => {
		const fullText = [
			`# Page: One\n${"a".repeat(60_000)}`,
			`# Page: Two\n${"b".repeat(60_000)}`,
			`# Page: Three\n${"c".repeat(60_000)}`,
		].join("\n");
		callDeepWikiMock.mockResolvedValue({
			...response(fullText, "read_wiki_contents"),
			pageTitles: ["One", "Two", "Three"],
		});
		const result = await executeDeepWiki(
			{ action: "contents", repoName: "phase4/full-contents" },
			undefined,
			undefined,
		);
		const text = textOf(result);
		expect(text.length).toBeLessThanOrEqual(DEEPWIKI_OUTPUT_CHAR_BUDGET);
		expect(text).toContain("[DeepWiki contents truncated — showing 1 of 3 pages");
		expect(text).toContain("Omitted pages: Two; Three");
		expect(result.details.shownPages).toBe(1);
		expect(result.details.truncatedChars).toBeGreaterThan(0);
	});

	it("bounds a single oversized page and keeps its resolved page metadata", async () => {
		const fullText = `# Page: Huge\n${"x".repeat(DEEPWIKI_OUTPUT_CHAR_BUDGET + 10_000)}\n# Page: Small\nok`;
		callDeepWikiMock.mockResolvedValue({
			...response(fullText, "read_wiki_contents"),
			pageTitles: ["Huge", "Small"],
		});
		const result = await executeDeepWiki(
			{ action: "contents", repoName: "phase4/single-page", page: 1 },
			undefined,
			undefined,
		);
		const text = textOf(result);
		expect(text.length).toBeLessThanOrEqual(DEEPWIKI_OUTPUT_CHAR_BUDGET);
		expect(text).toContain("# Page: Huge");
		expect(text).not.toContain("# Page: Small");
		expect(text).toContain("The last shown page is itself truncated");
		expect(result.details.requestedPage).toBe("Huge");
		expect(result.details.pageIndex).toBe(1);
		expect(result.details.truncatedChars).toBeGreaterThan(0);
	});

	it("leaves below-budget responses unchanged", async () => {
		callDeepWikiMock.mockResolvedValue(response("Short answer", "ask_question"));
		const result = await executeDeepWiki(
			{ action: "question", repoName: "phase4/short-answer", question: "How?" },
			undefined,
			undefined,
		);
		expect(textOf(result)).toBe("Short answer");
		expect(result.details.truncatedChars).toBeUndefined();
	});
});
