import { describe, expect, it } from "vitest";
import { clampInt, envInt } from "../src/extensions/search/clamp.ts";

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

	it("parses numeric strings, which is how environment knobs arrive", () => {
		expect(clampInt("4", 3, 0, 6)).toBe(4);
		expect(clampInt("", 3, 0, 6)).toBe(3);
	});
});

describe("envInt", () => {
	it("reads and clamps an FC_* knob", () => {
		process.env.FC_TEST_KNOB = "12";
		expect(envInt("FC_TEST_KNOB", 1, 1, 8)).toBe(8);
		delete process.env.FC_TEST_KNOB;
	});

	it("uses the default when the variable is unset", () => {
		expect(envInt("FC_TEST_KNOB_UNSET", 4, 1, 8)).toBe(4);
	});
});
