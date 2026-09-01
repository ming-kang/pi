import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { DeepWikiParamsSchema, normalizeDeepWikiParams } from "../src/extensions/deepwiki/schema.ts";

const validate = Compile(DeepWikiParamsSchema);

describe("DeepWiki page validation", () => {
	it("expresses numeric pages as positive 1-based integers", () => {
		expect(validate.Check({ action: "contents", repoName: "owner/repo", page: 1 })).toBe(true);
		expect(validate.Check({ action: "contents", repoName: "owner/repo", page: "Overview" })).toBe(true);
		expect(validate.Check({ action: "contents", repoName: "owner/repo", page: 0 })).toBe(false);
		expect(validate.Check({ action: "contents", repoName: "owner/repo", page: -1 })).toBe(false);
		expect(validate.Check({ action: "contents", repoName: "owner/repo", page: 1.5 })).toBe(false);
	});

	it("defensively rejects non-positive, fractional, non-finite, blank, and non-scalar pages", () => {
		for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "", "   ", {}, []]) {
			expect(() => normalizeDeepWikiParams({ action: "contents", repoName: "owner/repo", page } as never)).toThrow(
				/page must be/,
			);
		}
	});

	it("normalizes valid page titles and positive numeric aliases", () => {
		expect(
			normalizeDeepWikiParams({ action: "contents", repoName: "owner/repo", pageTitle: "  4.4 Extension System  " }),
		).toMatchObject({ page: "Extension System" });
		expect(normalizeDeepWikiParams({ repoName: "owner/repo", pageName: 2 })).toEqual({
			action: "contents",
			repoName: "owner/repo",
			page: 2,
		});
	});
});
