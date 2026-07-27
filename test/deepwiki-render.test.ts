import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { DeepWikiDetails } from "../src/extensions/deepwiki/execute.ts";
import { renderDeepWikiCall, renderDeepWikiResult } from "../src/extensions/deepwiki/render.ts";
import type { DeepWikiParams } from "../src/extensions/deepwiki/schema.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let usedColors: string[] = [];
const theme = {
	fg: (color: string, text: string) => {
		usedColors.push(color);
		return text;
	},
	bold: (text: string) => text,
} as unknown as Theme;

function result(text: string, details: DeepWikiDetails): AgentToolResult<DeepWikiDetails> {
	return { content: [{ type: "text", text }], details };
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	usedColors = [];
	setKeybindings(new KeybindingsManager());
});

describe("renderDeepWikiCall", () => {
	test("normalizes question whitespace before applying the headline limit", () => {
		const args: DeepWikiParams = {
			action: "question",
			repoName: "owner/repo",
			question:
				"How does\n\t  extension rendering preserve   compact summaries while still exposing complete details to users?",
		};
		const lines = renderDeepWikiCall(args, theme)
			.render(240)
			.map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("How does extension rendering preserve compact summaries");
		expect(lines[0]).not.toContain("\t");
		expect(lines[0]).not.toContain("  ");
		expect(lines[0]).toContain("...");
	});
});

describe("renderDeepWikiResult", () => {
	test("keeps the collapsed summary and expand hint on one logical line", () => {
		const component = renderDeepWikiResult(
			result("The renderer keeps summaries concise. More detail follows.", {
				action: "question",
				repoName: "owner/repo",
			}),
			{ expanded: false, isPartial: false },
			theme,
			false,
		);
		const lines = component.render(240).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("The renderer keeps summaries concise.");
		expect(usedColors).toContain("toolOutput");
		expect(usedColors).not.toContain("accent");
		expect(lines[0]).toContain("ctrl+o to expand");
	});

	test("wraps safely at narrow widths", () => {
		const component = renderDeepWikiResult(
			result("A concise answer with enough words to wrap across several narrow terminal lines.", {
				action: "question",
				repoName: "owner/repo",
			}),
			{ expanded: false, isPartial: false },
			theme,
			false,
		);
		const lines = component.render(30);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("bounds and normalizes historical page-title summaries", () => {
		const component = renderDeepWikiResult(
			result("wiki", {
				action: "structure",
				repoName: "owner/repo",
				pageCount: 2,
				pageTitles: ["First\nPage", "x".repeat(300)],
			}),
			{ expanded: false, isPartial: false },
			theme,
			false,
		);
		const lines = component.render(500).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("First Page");
		expect(lines[0]).toContain("...");
		expect(lines[0]).not.toContain("x".repeat(200));
	});

	test("falls back safely for malformed historical details", () => {
		const malformed = {
			action: "contents",
			repoName: "owner/repo",
			requestedPage: { bad: true },
			pageTitles: { bad: true },
			errorMessage: { bad: true },
		} as unknown as DeepWikiDetails;
		const collapsed = renderDeepWikiResult(
			result("No structured wiki", malformed),
			{ expanded: false, isPartial: false },
			theme,
			false,
		);
		expect(stripAnsi(collapsed.render(120).join("\n"))).toContain("Wiki loaded");

		const failed = renderDeepWikiResult(
			result("Service failed", malformed),
			{ expanded: false, isPartial: false },
			theme,
			true,
		);
		expect(stripAnsi(failed.render(120).join("\n"))).toContain("failed · Service failed");
	});

	test("keeps expanded Markdown free of the collapsed hint", () => {
		const component = renderDeepWikiResult(
			result("# Result\n\n- First detail", { action: "question", repoName: "owner/repo" }),
			{ expanded: true, isPartial: false },
			theme,
			false,
		);
		const output = stripAnsi(component.render(120).join("\n"));
		expect(output).toContain("Result");
		expect(output).toContain("- First detail");
		expect(output).not.toContain("to expand");
	});
});
