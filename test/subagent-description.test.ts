import { describe, expect, it } from "vitest";
import { subagentGroupTitle, taskLabel } from "../src/extensions/subagent/resolve.ts";

describe("subagent task labels", () => {
	it("prefers an explicit trimmed description over the prompt", () => {
		expect(taskLabel({ prompt: "Line one\nLine two", description: "  Find retry code  " })).toBe("Find retry code");
	});

	it("derives a bounded label from the first plain prompt line when description is omitted or null", () => {
		expect(taskLabel({ prompt: "# Heading one\nbody" })).toBe("Heading one");
		expect(taskLabel({ prompt: "Long prompt", description: null })).toBe("Long prompt");
		expect(taskLabel({ prompt: "  \nSecond line wins" })).toBe("Second line wins");
		expect([...taskLabel({ prompt: "x".repeat(120) })]).toHaveLength(80);
	});

	it("titles a single-task group with its label", () => {
		expect(subagentGroupTitle([{ prompt: "p", description: "Solo run" }])).toBe("Subagent · Solo run");
	});

	it("titles multi-task groups with per-task labels, bounded", () => {
		expect(
			subagentGroupTitle([
				{ prompt: "p", description: "Alpha" },
				{ prompt: "p", description: "Beta" },
			]),
		).toBe("Subagent · 2 tasks: Alpha, Beta");
		const long = subagentGroupTitle(
			Array.from({ length: 8 }, (_, index) => ({ prompt: "p", description: `Task-${index}-${"x".repeat(40)}` })),
		);
		expect(long.startsWith("Subagent · 8 tasks: ")).toBe(true);
		expect([...long]).toHaveLength(100);
	});
});
