import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { WebSearchRenderState } from "../src/extensions/web-search/render.ts";
import { renderWebSearchCall, renderWebSearchResult } from "../src/extensions/web-search/render.ts";
import { MAX_HISTORICAL_HIT_SCAN } from "../src/extensions/web-search/results.ts";
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

function renderContext(isError = false, elapsedMs = 0): ToolRenderContext<WebSearchRenderState> {
	return {
		isError,
		state: { startedAt: Date.now() - elapsedMs },
		invalidate: () => {},
	} as ToolRenderContext<WebSearchRenderState>;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	vi.useFakeTimers();
	usedColors = [];
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.useRealTimers());

describe("renderWebSearchCall & renderWebSearchResult", () => {
	test("renderWebSearchCall renders label and query", () => {
		const comp = renderWebSearchCall({ query: "TypeScript 5.5" }, theme);
		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain('Web Search "TypeScript 5.5"');
	});

	test("renderWebSearchCall tolerates incomplete streaming arguments", () => {
		const comp = renderWebSearchCall(undefined, theme);
		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain('Web Search ""');
	});

	test("renderWebSearchResult renders collapsed summary with result counts and duration", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "Full search payload" }],
				details: {
					query: "TypeScript 5.5",
					durationMs: 1200,
					status: "success",
					engine: "dual",
					totalHits: 5,
					hits: [],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(false),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("5 results via MiniMax & DeepSeek · 1.2s");
		expect(lines[0]).toContain("ctrl+o to expand");
	});

	test("renderWebSearchResult renders disabled status nicely even with a legacy error flag", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "Disabled" }],
				details: {
					query: "test",
					durationMs: 0,
					status: "disabled",
					engine: "none",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(true),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("disabled · no MiniMax/DeepSeek key — /login minimax-cn");
		expect(usedColors).toContain("warning");
		expect(usedColors).not.toContain("error");
	});

	test("renderWebSearchResult renders in-progress state without repeating the query", () => {
		const comp = renderWebSearchResult(
			{
				content: [],
				details: {
					query: "TypeScript 7 release",
					durationMs: 0,
					status: "success",
					engine: "dual",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			renderContext(false, 3000),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Searching via MiniMax & DeepSeek... (3s)");
		expect(lines[0]).not.toContain("TypeScript 7 release");
	});

	test("renderWebSearchResult hides elapsed time below the 2s threshold", () => {
		const comp = renderWebSearchResult(
			{
				content: [],
				details: {
					query: "q",
					durationMs: 0,
					status: "success",
					engine: "minimax",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			renderContext(false, 1200),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Searching via MiniMax...");
		expect(lines[0]).not.toContain("(1s)");
	});

	test("renderWebSearchResult collapsed summary previews top hit domains", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "payload" }],
				details: {
					query: "q",
					durationMs: 800,
					status: "success",
					engine: "dual",
					totalHits: 3,
					hits: [
						{ title: "A", url: "https://www.example.com/a", sources: ["MiniMax"] },
						{ title: "B", url: "https://foo.org/b", sources: ["DeepSeek"] },
						{ title: "C", url: "https://bar.net/c", sources: ["MiniMax"] },
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(false),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("3 results via MiniMax & DeepSeek · 0.8s · example.com, foo.org, +1");
	});

	test("bounds historical domain scans in the collapsed renderer", () => {
		const hits = Array.from({ length: MAX_HISTORICAL_HIT_SCAN }, () => null) as unknown[];
		hits[0] = { title: "A", url: "https://example.com/a", sources: ["MiniMax"] };
		Object.defineProperty(hits, MAX_HISTORICAL_HIT_SCAN, {
			get: () => {
				throw new Error("domain scan exceeded");
			},
		});
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "payload" }],
				details: {
					query: "q",
					durationMs: 10,
					status: "success",
					engine: "minimax",
					totalHits: 1,
					hits: hits as never,
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(false),
		);
		expect(stripAnsi(comp.render(120).join("\n"))).toContain("example.com");
	});

	test("renderWebSearchResult expanded renders structured sections without agent directives", () => {
		const comp = renderWebSearchResult(
			{
				content: [
					{
						type: "text",
						text: '# Web Search Results for: "q"\n\n...\n---\nUse these search results to answer the user, and cite the relevant source URLs in your response.',
					},
				],
				details: {
					query: "q",
					durationMs: 100,
					status: "success",
					engine: "deepseek",
					totalHits: 1,
					hits: [
						{ title: "Announcing X", url: "https://example.com/x", snippet: "A snippet", sources: ["DeepSeek"] },
					],
					deepseekSynthesis: "Synthesis text",
					relatedSearches: ["related one"],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			renderContext(false),
		);

		const rendered = comp
			.render(120)
			.map((l) => stripAnsi(l))
			.join("\n");
		expect(rendered).toContain("Web Sources (1 found via DeepSeek)");
		expect(rendered).toContain("Announcing X");
		expect(rendered).toContain("DeepSeek Search Synthesis");
		expect(rendered).toContain("Related Searches");
		expect(rendered).not.toContain("cite the relevant source URLs");
	});

	test("renderWebSearchResult falls back to payload text when details are missing", () => {
		const comp = renderWebSearchResult(
			// Legacy sessions on disk may lack details even though the type requires it.
			{ content: [{ type: "text", text: "Some legacy payload line" }], details: undefined as never },
			{ expanded: false, isPartial: false },
			theme,
			renderContext(false),
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Some legacy payload line");
		expect(lines[0]).toContain("ctrl+o to expand");
	});
});
