import { describe, expect, test } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const EXPECTED_BUILT_INS = [
	"llama.cpp",
	"btw",
	"deepwiki",
	"explore",
	"provider",
	"question",
	"statusline",
	"todo",
	"web_search",
];

describe("built-in extensions", () => {
	test("loads Explore without the removed general delegation tools", async () => {
		const loaded = await createTestExtensionsResult(
			builtInExtensions.map((extension) => (typeof extension === "function" ? extension : extension.factory)),
		);
		expect(loaded.errors).toEqual([]);
		const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(tools).toContain("deepwiki");
		expect(tools).not.toContain("subagent");
		expect(tools).toContain("explore");
		expect(commands).not.toContain("agents");
		expect(commands).toContain("explore");
	});
	test("keeps the canonical bundled extension set hidden", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toEqual(EXPECTED_BUILT_INS);
		expect(builtInExtensions.every((extension) => typeof extension !== "function" && extension.hidden === true)).toBe(
			true,
		);
	});
});
