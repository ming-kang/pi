import { describe, expect, test } from "vitest";
import {
	fuseSearchHits,
	MAX_RELATED_SEARCH_LENGTH,
	MAX_SNIPPET_LENGTH,
	MAX_SYNTHESIS_LENGTH,
	MAX_TITLE_LENGTH,
	MAX_URL_LENGTH,
	normalizeUrl,
} from "../src/extensions/web-search/results.ts";
import type { ProviderSearchResult } from "../src/extensions/web-search/types.ts";

describe("normalizeUrl", () => {
	test("strips tracking parameters and fragments", () => {
		const raw = "https://example.com/page?utm_source=twitter&utm_medium=social&ref=blog#section1";
		expect(normalizeUrl(raw)).toBe("https://example.com/page");
	});

	test("preserves non-tracking query parameters, including trailing slashes in values", () => {
		expect(normalizeUrl("https://example.com/search?q=hello&utm_source=test")).toBe(
			"https://example.com/search?q=hello",
		);
		expect(normalizeUrl("https://example.com/search?q=foo/")).toBe("https://example.com/search?q=foo/");
	});

	test("strips trailing slashes from the path even when a query is present", () => {
		expect(normalizeUrl("https://example.com/docs/")).toBe("https://example.com/docs");
		expect(normalizeUrl("https://example.com/docs/?tab=1")).toBe("https://example.com/docs?tab=1");
		expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
	});

	test("rejects malformed, non-HTTP, and oversized source URLs", () => {
		expect(normalizeUrl("not a url")).toBeUndefined();
		expect(normalizeUrl("file:///tmp/result")).toBeUndefined();
		expect(normalizeUrl(`https://example.com/${"x".repeat(MAX_URL_LENGTH)}`)).toBeUndefined();
	});
});

describe("fuseSearchHits", () => {
	test("counts repeated URLs from one provider once and retains their original rank", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [
					{ title: "Invalid", url: "file:///invalid" },
					{ title: "A", url: "https://a.test/" },
					{ title: "A again", url: "https://a.test/?utm_source=duplicate" },
				],
			},
			{ source: "DeepSeek", hits: [{ title: "Z", url: "https://z.test/" }] },
		]);
		expect(fused.hits.map((hit) => hit.url)).toEqual(["https://z.test/", "https://a.test/"]);
		expect(fused.hits[1].sources).toEqual(["MiniMax"]);
	});
	test("deduplicates overlapping URLs and ranks cross-provider hits first", () => {
		const provider1: ProviderSearchResult = {
			source: "MiniMax",
			hits: [
				{
					title: "React 19 Official",
					url: "https://react.dev/blog/react-19?utm_source=mm",
					snippet: "Official React 19 announcement.",
				},
				{
					title: "MiniMax Only Blog",
					url: "https://blog.minimax.com/post",
					snippet: "MiniMax snippet",
				},
			],
		};

		const provider2: ProviderSearchResult = {
			source: "DeepSeek",
			hits: [
				{
					title: "React 19 Release",
					url: "https://react.dev/blog/react-19#heading",
					snippet: "DeepSeek longer snippet with more detailed context.",
				},
				{
					title: "DeepSeek Only Article",
					url: "https://dev.to/deepseek/post",
					snippet: "DeepSeek snippet",
				},
			],
			synthesisText: "Key takeaways about React 19...",
		};

		const fused = fuseSearchHits([provider1, provider2]);

		expect(fused.hits).toHaveLength(3);
		// First hit should be the one found by both providers
		expect(fused.hits[0].url).toBe("https://react.dev/blog/react-19");
		expect(fused.hits[0].sources).toEqual(["MiniMax", "DeepSeek"]);
		// Prefers longer snippet
		expect(fused.hits[0].snippet).toBe("DeepSeek longer snippet with more detailed context.");
		expect(fused.deepseekSynthesis).toBe("Key takeaways about React 19...");
	});
	test("includes high-ranked unique results from both providers", () => {
		const provider = (source: "MiniMax" | "DeepSeek", host: string): ProviderSearchResult => ({
			source,
			hits: Array.from({ length: 12 }, (_, index) => ({
				title: `${source} ${index}`,
				url: `https://${host}/${index}`,
			})),
		});
		const fused = fuseSearchHits([provider("MiniMax", "minimax.test"), provider("DeepSeek", "deepseek.test")]);
		const sources = new Set(fused.hits.flatMap((hit) => hit.sources));
		expect(fused.hits).toHaveLength(12);
		expect(sources).toEqual(new Set(["MiniMax", "DeepSeek"]));
	});

	test("produces the same ranking regardless of provider input order", () => {
		const minimax: ProviderSearchResult = {
			source: "MiniMax",
			hits: [
				{ title: "M1", url: "https://m.test/1" },
				{ title: "M2", url: "https://m.test/2" },
			],
		};
		const deepseek: ProviderSearchResult = {
			source: "DeepSeek",
			hits: [
				{ title: "D1", url: "https://d.test/1" },
				{ title: "D2", url: "https://d.test/2" },
			],
		};
		expect(fuseSearchHits([minimax, deepseek]).hits.map((hit) => hit.url)).toEqual(
			fuseSearchHits([deepseek, minimax]).hits.map((hit) => hit.url),
		);
	});

	test("upgrades a URL fallback title when another provider has a descriptive title", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [{ title: "https://example.com/docs", url: "https://example.com/docs" }],
			},
			{
				source: "DeepSeek",
				hits: [{ title: "Example documentation", url: "https://example.com/docs/" }],
			},
		]);
		expect(fused.hits[0].title).toBe("Example documentation");
	});

	test("bounds provider-controlled fields and drops unusable source URLs", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [
					{
						title: `Title\n${"x".repeat(MAX_TITLE_LENGTH + 20)}`,
						url: "https://example.com/result",
						snippet: `Snippet\n${"y".repeat(MAX_SNIPPET_LENGTH + 20)}`,
					},
					{ title: "Local", url: "file:///tmp/result" },
				],
				relatedSearches: [`Related\n${"z".repeat(MAX_RELATED_SEARCH_LENGTH + 20)}`],
				synthesisText: "s".repeat(MAX_SYNTHESIS_LENGTH + 20),
			},
		]);
		expect(fused.hits).toHaveLength(1);
		expect(fused.hits[0].title).not.toContain("\n");
		expect(fused.hits[0].title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
		expect(fused.hits[0].snippet?.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);
		expect(fused.relatedSearches?.[0].length).toBeLessThanOrEqual(MAX_RELATED_SEARCH_LENGTH);
		expect(fused.deepseekSynthesis?.length).toBeLessThanOrEqual(MAX_SYNTHESIS_LENGTH);
	});

	test("caps related searches at 8 entries", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [],
				relatedSearches: Array.from({ length: 20 }, (_, i) => `related ${i}`),
			},
		]);
		expect(fused.relatedSearches).toHaveLength(8);
	});
});
