import { describe, expect, test } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";

const EXPECTED_BUILT_INS = [
	"llama.cpp",
	"background",
	"deepwiki",
	"question",
	"router",
	"statusline",
	"subagent",
	"todo",
	"web_search",
];

describe("built-in extensions", () => {
	test("keeps the canonical bundled extension set hidden", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toEqual(EXPECTED_BUILT_INS);
		expect(builtInExtensions.every((extension) => typeof extension !== "function" && extension.hidden === true)).toBe(
			true,
		);
	});
});
