import { describe, expect, test } from "vitest";
import { formatSearchOutput } from "../src/extensions/web-search/format.ts";
import {
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_HISTORICAL_HIT_SCAN,
	MAX_HISTORICAL_RELATED_SCAN,
	MAX_HISTORICAL_SOURCE_SCAN,
} from "../src/extensions/web-search/results.ts";
import type { WebSearchHit } from "../src/extensions/web-search/types.ts";

describe("formatSearchOutput", () => {
	test("formats disabled state with help message", () => {
		const output = formatSearchOutput({
			query: "query",
			durationMs: 0,
			status: "disabled",
			engine: "none",
			totalHits: 0,
			hits: [],
		});
		expect(output).toContain("Web search is disabled");
		expect(output).toContain("auth.json");
	});

	test("bounds model-facing structured error messages", () => {
		const output = formatSearchOutput({
			query: "query",
			durationMs: 10,
			status: "error",
			engine: "minimax",
			totalHits: 0,
			hits: [],
			errorMessage: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 100),
		});
		const message = output.slice(output.indexOf(": ") + 2);
		expect(message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
		expect(message.endsWith("...")).toBe(true);
	});

	test("formats dual search output with provider-overlap labels and synthesis provenance", () => {
		const hits: WebSearchHit[] = [
			{
				title: "React 19 Docs",
				url: "https://react.dev",
				snippet: "React 19 documentation.",
				sources: ["MiniMax", "DeepSeek"],
			},
		];
		const output = formatSearchOutput({
			query: "react 19",
			durationMs: 1200,
			status: "success",
			engine: "dual",
			totalHits: 1,
			hits,
			deepseekSynthesis: "Synthesis points here.",
		});

		expect(output).toContain('# Web Search Results for: "react 19"');
		expect(output).toContain("[React 19 Docs](<https://react.dev/>)");
		expect(output).toContain("Web Sources (1 found via MiniMax & DeepSeek)");
		expect(output).toContain("found by MiniMax & DeepSeek");
		expect(output).toContain("DeepSeek Search Synthesis");
		expect(output).toContain("Synthesis points here.");
		expect(output).not.toContain("verified by");
		expect(output).toContain("cite the relevant source URLs in your response");
		expect(output).not.toContain("CRITICAL REQUIREMENT");
		expect(output).not.toContain("Sources:");
	});

	test("bounds and canonicalizes source labels from historical details", () => {
		const output = formatSearchOutput({
			query: "release",
			durationMs: 10,
			status: "success",
			engine: "minimax",
			totalHits: 1,
			hits: [
				{
					title: "Release",
					url: "https://example.com/release",
					sources: [...Array.from({ length: 1000 }, () => "MiniMax"), "**Injected**"] as never,
				},
			],
		});
		expect(output).not.toContain("Injected");
		expect(output.length).toBeLessThan(1000);
	});

	test("does not scan past historical hit, source, or related-search limits", () => {
		const hits = Array.from({ length: MAX_HISTORICAL_HIT_SCAN }, () => null) as unknown[];
		const related = Array.from({ length: MAX_HISTORICAL_RELATED_SCAN }, () => null) as unknown[];
		Object.defineProperty(related, MAX_HISTORICAL_RELATED_SCAN, {
			get: () => {
				throw new Error("related scan exceeded");
			},
		});
		const sources = Array.from({ length: MAX_HISTORICAL_SOURCE_SCAN }, () => "MiniMax") as unknown[];
		Object.defineProperty(sources, MAX_HISTORICAL_SOURCE_SCAN, {
			get: () => {
				throw new Error("source scan exceeded");
			},
		});
		hits[0] = {
			title: "Release",
			url: "https://example.com/release",
			sources,
		};
		Object.defineProperty(hits, MAX_HISTORICAL_HIT_SCAN, {
			get: () => {
				throw new Error("hit scan exceeded");
			},
		});

		expect(() =>
			formatSearchOutput({
				query: "release",
				durationMs: 10,
				status: "success",
				engine: "minimax",
				totalHits: 1,
				hits: hits as never,
				relatedSearches: related as never,
			}),
		).not.toThrow();
	});

	test("escapes Markdown titles and normalizes multiline snippets", () => {
		const output = formatSearchOutput({
			query: "release",
			durationMs: 10,
			status: "success",
			engine: "minimax",
			totalHits: 1,
			hits: [
				{
					title: "[Release]\\notes\n2026",
					url: "https://example.com/release",
					snippet: "First line\n[open](javascript:alert(1))",
					sources: ["MiniMax"],
				},
			],
		});
		expect(output).toContain("[\\[Release\\]\\\\notes 2026](<https://example.com/release>)");
		expect(output).toContain("First line \\[open\\](javascript:alert(1))");
		expect(output).not.toContain("First line [open](javascript:alert(1))");
	});

	test("neutralizes Markdown links in synthesis and related searches", () => {
		const output = formatSearchOutput({
			query: "release",
			durationMs: 10,
			status: "success",
			engine: "deepseek",
			totalHits: 0,
			hits: [],
			deepseekSynthesis: "[open](javascript:alert(1)) and <file:///tmp/source>",
			relatedSearches: ["[related](javascript:alert(2))"],
		});
		expect(output).toContain("\\[open\\](javascript:alert(1))");
		expect(output).toContain("\\<file:///tmp/source\\>");
		expect(output).toContain("\\[related\\](javascript:alert(2))");
		expect(output).not.toContain("[open](javascript:alert(1))");
	});

	test("does not request citations when synthesis has no source URLs", () => {
		const output = formatSearchOutput({
			query: "react 19",
			durationMs: 1200,
			status: "success",
			engine: "deepseek",
			totalHits: 0,
			hits: [],
			deepseekSynthesis: "Synthesis without structured sources.",
		});

		expect(output).toContain("Synthesis without structured sources.");
		expect(output).not.toContain("cite the relevant source URLs");
		expect(output).not.toContain("Sources:");
	});
});
