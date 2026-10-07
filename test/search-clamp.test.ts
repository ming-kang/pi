import { describe, expect, it } from "vitest";
import { clampInt } from "../src/extensions/search/clamp.ts";

describe("clampInt", () => {
	it("keeps 0, which call sites treat as a real value", () => {
		expect(clampInt(0, 3, 0, 6)).toBe(0);
	});

	it("clamps to the bounds and rounds numbers", () => {
		expect(clampInt(-5, 3, 0, 6)).toBe(0);
		expect(clampInt(99, 3, 0, 6)).toBe(6);
		expect(clampInt(2.6, 3, 0, 6)).toBe(3);
	});

	it("falls back to the default for non-numeric input", () => {
		expect(clampInt(undefined, 3, 0, 6)).toBe(3);
		expect(clampInt("abc", 3, 0, 6)).toBe(3);
		expect(clampInt(Number.NaN, 3, 0, 6)).toBe(3);
		expect(clampInt(true, 3, 0, 6)).toBe(3);
	});

	it("parses numeric strings, which is how loose tool arguments arrive", () => {
		expect(clampInt("4", 3, 0, 6)).toBe(4);
		expect(clampInt("", 3, 0, 6)).toBe(3);
	});
});
