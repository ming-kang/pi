import { describe, expect, it } from "vitest";
import { moreOptionsHint, windowItems } from "../src/extensions/question/option-window.ts";

function options(count: number, height = 2) {
	return Array.from({ length: count }, () => ({ height, countsAsOption: true }));
}

describe("question option window", () => {
	it("shows everything without hints when the items fit", () => {
		const window = windowItems(options(3), 1, 6);
		expect(window).toMatchObject({ first: 0, last: 2, showAbove: false, showBelow: false });
	});

	it("frees the top hint row at the start of the list and counts hidden options below", () => {
		// 8 options x 2 rows in 10 rows: one bottom hint row leaves 9 rows, so 4 whole options fit.
		const window = windowItems(options(8), 0, 10);
		expect(window).toMatchObject({ first: 0, last: 3, showAbove: false, showBelow: true, hiddenBelow: 4 });
		expect(window.contentRows).toBe(9);
	});

	it("frees the bottom hint row at the end of the list and counts hidden options above", () => {
		const window = windowItems(options(8), 7, 10);
		expect(window).toMatchObject({ first: 4, last: 7, showAbove: true, showBelow: false, hiddenAbove: 4 });
	});

	it("keeps the focused option between both hints in the middle of the list", () => {
		const window = windowItems(options(10), 5, 10);
		expect(window.showAbove && window.showBelow).toBe(true);
		expect(window.first).toBeLessThanOrEqual(5);
		expect(window.last).toBeGreaterThanOrEqual(5);
		expect(window.hiddenAbove + window.hiddenBelow + (window.last - window.first + 1)).toBe(10);
		expect(window.contentRows).toBe(8);
	});

	it("never counts a pseudo item as an option", () => {
		const items = [...options(6), { height: 3, countsAsOption: false }];
		const window = windowItems(items, 6, 8);
		expect(window.last).toBe(6);
		expect(window.hiddenAbove).toBe(window.first);
	});

	it("keeps only the focused item when it is taller than the window", () => {
		const items = [{ height: 2, countsAsOption: true }, { height: 12, countsAsOption: true }, ...options(2)];
		const window = windowItems(items, 1, 6);
		expect(window).toMatchObject({ first: 1, last: 1, hiddenAbove: 1, hiddenBelow: 2 });
	});

	it("drops the hints when there are too few rows to hold them", () => {
		const window = windowItems(options(5), 2, 2);
		expect(window).toMatchObject({ first: 2, last: 2, contentRows: 2, showAbove: false, showBelow: false });
	});

	it("words the hint by direction and count", () => {
		expect(moreOptionsHint("down", 1)).toBe("↓ 1 more option");
		expect(moreOptionsHint("up", 3)).toBe("↑ 3 more options");
		expect(moreOptionsHint("down", 0)).toBe("↓ more below");
	});
});
