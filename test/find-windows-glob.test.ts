import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesFindResultPath } from "../src/core/tools/find.ts";

describe("find on Windows", () => {
	const searchRoot = "C:\\repo";

	it("matches POSIX glob segments against backslash and slash fd output", () => {
		expect(matchesFindResultPath("C:\\repo\\src\\core\\file.ts", searchRoot, "src/**/*.ts", win32)).toBe(true);
		expect(matchesFindResultPath("C:/repo/src/core/file.ts", searchRoot, "src/**/*.ts", win32)).toBe(true);
		expect(matchesFindResultPath("C:\\repo\\test\\file.ts", searchRoot, "src/**/*.ts", win32)).toBe(false);
	});

	it("preserves directory markers and the existing case rule", () => {
		expect(matchesFindResultPath("C:\\repo\\src\\nested\\", searchRoot, "src/**/", win32)).toBe(true);
		expect(matchesFindResultPath("C:\\repo\\SRC\\file.ts", searchRoot, "src/*.ts", win32)).toBe(true);
		expect(matchesFindResultPath("C:\\repo\\src\\file.ts", searchRoot, "SRC/*.ts", win32)).toBe(false);
	});
});
