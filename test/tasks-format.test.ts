import { describe, expect, it } from "vitest";
import { formatTaskActivityDuration } from "../src/core/tasks/activity.ts";
import { formatDuration } from "../src/utils/duration.ts";

describe("task duration formatting", () => {
	it("omits zero components and separates remaining units", () => {
		expect(formatDuration(0)).toBe("<1s");
		expect(formatDuration(499)).toBe("<1s");
		expect(formatDuration(500)).toBe("1s");
		expect(formatDuration(8_000)).toBe("8s");
		expect(formatDuration(59_500)).toBe("1m");
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h 1m");
	});
});

describe("task activity duration formatting", () => {
	it("uses milliseconds, tenths of a second, then the shared duration form", () => {
		const text = [0, 4, 999.4, 999.6, 1000, 1500, 59_940, 59_960, 65_000, 3_600_000].map(formatTaskActivityDuration);
		expect(text).toEqual(["0ms", "4ms", "999ms", "1.0s", "1.0s", "1.5s", "59.9s", "1m", "1m 5s", "1h"]);
		expect(formatTaskActivityDuration(undefined)).toBe("");
	});
});
