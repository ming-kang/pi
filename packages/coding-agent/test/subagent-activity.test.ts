import { describe, expect, it } from "vitest";
import { boundText } from "../src/extensions/subagent/activity.ts";
import { DETAILS_OUTPUT_LIMIT } from "../src/extensions/subagent/constants.ts";
import { boundSubagentDetails } from "../src/extensions/subagent/runner.ts";
import type { SubagentDetails } from "../src/extensions/subagent/types.ts";

describe("subagent output bounds", () => {
	it("never exceeds the requested UTF-8 byte budget, including the truncation notice", () => {
		for (const limit of [1, 8, 32, 64, 256]) {
			const bounded = boundText("界".repeat(1_000), limit);
			expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(limit);
		}
	});

	it("bounds aggregate details even when every worker produces large evidence", () => {
		const details: SubagentDetails = {
			mode: "parallel",
			status: "failed",
			startedAt: 0,
			usage: { turns: 8, toolUses: 640, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			runs: Array.from({ length: 8 }, (_, index) => ({
				id: `subagent-${index + 1}`,
				agent: `worker-${index + 1}`,
				agentSource: "user",
				description: "Inspect the bounded details implementation",
				prompt: "界".repeat(20_000),
				cwd: "/workspace/".concat("nested/".repeat(2_000)),
				model: "provider/model",
				thinking: "medium",
				status: "failed",
				activities: Array.from({ length: 80 }, (_, activityIndex) => ({
					id: `tool-${activityIndex}`,
					toolName: "read",
					summary: "界".repeat(1_000),
					status: "failed",
					startedAt: 0,
					resultSummary: "界".repeat(1_000),
				})),
				liveText: "界".repeat(8_000),
				finalOutput: "界".repeat(32_000),
				error: "界".repeat(8_000),
				usage: {
					turns: 1,
					toolUses: 80,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: 0,
				},
			})),
		};
		const bounded = boundSubagentDetails(details);
		expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(DETAILS_OUTPUT_LIMIT);
		expect(bounded.runs.every((run) => run.activities.length <= 4)).toBe(true);
	});
});
