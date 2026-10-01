import { describe, expect, test } from "vitest";
import {
	getWebSearchPromptGuidelines,
	WEB_SEARCH_DESCRIPTION,
	WEB_SEARCH_PROMPT_SNIPPET,
} from "../src/extensions/web-search/constants.ts";
import { normalizeWebSearchParams } from "../src/extensions/web-search/schema.ts";

describe("web_search tool metadata", () => {
	test("keeps the snippet concise and the description provider-facing", () => {
		expect(WEB_SEARCH_PROMPT_SNIPPET).toBe("Search the live web for current information");
		expect(WEB_SEARCH_DESCRIPTION).toContain("MiniMax and DeepSeek");
		expect(WEB_SEARCH_DESCRIPTION).toContain("partial provider failures");
		expect(WEB_SEARCH_DESCRIPTION).not.toContain("allowed_domains");
	});

	test("keeps routing guidance tool-scoped and citation requirements result-scoped", () => {
		const guidelines = getWebSearchPromptGuidelines().join("\n");
		expect(guidelines).toContain("Use `web_search`");
		expect(guidelines).toContain("When using `web_search`");
		expect(guidelines).toMatch(/current date \(\d{4}-\d{2}\)/);
		expect(guidelines).not.toContain("IMPORTANT");
		expect(guidelines).not.toContain("Sources:");
		expect(guidelines).not.toContain("cite");
	});
});

describe("normalizeWebSearchParams", () => {
	test("normalizes plain string query", () => {
		expect(normalizeWebSearchParams("  react 19  ")).toEqual({ query: "react 19" });
	});

	test("normalizes aliased fields (q, search_query)", () => {
		expect(normalizeWebSearchParams({ q: "typescript 5.5" }).query).toBe("typescript 5.5");
		expect(normalizeWebSearchParams({ search_query: "bun 1.1" }).query).toBe("bun 1.1");
	});

	test("ignores removed domain-filter fields in legacy arguments", () => {
		expect(
			normalizeWebSearchParams({
				query: "nextjs",
				allowed_domains: ["nextjs.org"],
				blocked_domains: ["spam.com"],
			}),
		).toEqual({ query: "nextjs" });
	});
});
