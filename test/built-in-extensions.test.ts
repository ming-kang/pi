import { describe, expect, test } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createTestExtensionsResult } from "./utilities.ts";

const EXPECTED_BUILT_INS = [
	"codemode",
	"mcp",
	"tool-search",
	"llama.cpp",
	"btw",
	"deepwiki",
	"provider",
	"question",
	"statusline",
	"web_search",
];

describe("built-in extensions", () => {
	test("loads bundled tools without removed tools and commands", async () => {
		const loaded = await createTestExtensionsResult(
			builtInExtensions.map((extension) => (typeof extension === "function" ? extension : extension.factory)),
		);
		expect(loaded.errors).toEqual([]);
		const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(tools).toContain("deepwiki");
		expect(tools).not.toContain("subagent");
		expect(tools).not.toContain("explore");
		expect(tools).not.toContain("todo");
		expect(commands).not.toContain("agents");
		expect(commands).not.toContain("explore");
		expect(commands).not.toContain("todos");
	});
	test("marks the canonical bundled extension set as configurable built-ins", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toEqual(EXPECTED_BUILT_INS);
		expect(
			builtInExtensions.every((extension) => typeof extension !== "function" && extension.builtin === true),
		).toBe(true);
	});
});
