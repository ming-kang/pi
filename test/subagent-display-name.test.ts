import { describe, expect, it } from "vitest";
import { displayAgentName } from "../src/extensions/subagent/display-name.ts";

describe("Subagent profile display names", () => {
	it("title-cases display labels without changing identifiers", () => {
		expect(displayAgentName("general")).toBe("General");
		expect(displayAgentName("explorer")).toBe("Explorer");
		expect(displayAgentName("code-reviewer")).toBe("Code Reviewer");
		expect(displayAgentName("test_worker")).toBe("Test Worker");
	});
});
