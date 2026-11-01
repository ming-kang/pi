import { describe, expect, it } from "vitest";
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
