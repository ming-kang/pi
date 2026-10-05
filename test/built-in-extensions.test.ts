import { describe, expect, test } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createTestExtensionsResult } from "./utilities.ts";

describe("built-in extensions", () => {
	test("load together without errors as configurable built-ins", async () => {
		const loaded = await createTestExtensionsResult(
			builtInExtensions.map((extension) => (typeof extension === "function" ? extension : extension.factory)),
		);
		expect(loaded.errors).toEqual([]);
		expect(
			builtInExtensions.every((extension) => typeof extension !== "function" && extension.builtin === true),
		).toBe(true);
	});
});
