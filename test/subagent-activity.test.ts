import { describe, expect, it } from "vitest";
import {
	activityCallText,
	addUsage,
	emptyUsage,
	isDisplayableActivity,
	isSyntheticActivity,
	mergeUsage,
	toNestedUsage,
} from "../src/extensions/subagent/activity.ts";
import { boundSubagentDetails } from "../src/extensions/subagent/budget.ts";
import {
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	RETRY_ERROR_TEXT_LIMIT,
	TASK_OUTPUT_LIMIT,
} from "../src/extensions/subagent/constants.ts";
import { boundText } from "../src/extensions/subagent/text.ts";
import type { SubagentDetails, SubagentUsage, ToolActivity } from "../src/extensions/subagent/types.ts";

describe("subagent output bounds", () => {
	it("centralizes displayable activity classification and call-text formatting", () => {
		const read: ToolActivity = {
			id: "read-1",
			toolName: "read",
			summary: "read src/index.ts [Output truncated: 12 bytes omitted.]",
			status: "succeeded",
			startedAt: 0,
		};
		const compaction: ToolActivity = {
			id: "compaction",
			toolName: "compaction",
			summary: "Compacted 100k → 20k",
			status: "succeeded",
			startedAt: 1,
		};
		expect(isDisplayableActivity(read)).toBe(true);
		expect(isSyntheticActivity(read)).toBe(false);
		expect(activityCallText(read)).toBe("Read(src/index.ts...)");
		expect(isDisplayableActivity(compaction)).toBe(false);
		expect(isSyntheticActivity(compaction)).toBe(true);
	});

	it("never exceeds the requested UTF-8 byte budget, including the truncation notice", () => {
		for (const limit of [1, 8, 32, 64, 256]) {
			const bounded = boundText("界".repeat(1_000), limit);
			expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(limit);
		}
	});

	it("aggregates usage with a context-token watermark rather than a sum", () => {
		const usage = emptyUsage();
		addUsage(usage, {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 1_000,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		});
		addUsage(usage, {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		});
		expect(usage.input).toBe(101);
		expect(usage.output).toBe(52);
		expect(usage.cacheRead).toBe(10);
		expect(usage.totalTokens).toBe(1_500);
		expect(usage.cost).toBeCloseTo(0.4);
		// addUsage keeps the latest request's total as the context size, even
		// when it shrinks (for example after the worker auto-compacts).
		expect(usage.contextTokens).toBe(500);

		mergeUsage(usage, {
			turns: 1,
			toolUses: 2,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 800,
			cost: 0.2,
			contextTokens: 2_000,
		} satisfies SubagentUsage);
		expect(usage.turns).toBe(1);
		expect(usage.totalTokens).toBe(2_300);
		// mergeUsage keeps the highest context watermark across runs.
		expect(usage.contextTokens).toBe(2_000);

		const nested = toNestedUsage(usage);
		expect(nested.totalTokens).toBe(2_300);
		expect(nested.cost?.total).toBeCloseTo(0.6);
	});

	it("leaves small details unchanged", () => {
		const small: SubagentDetails = {
			status: "completed",
			startedAt: 0,
			usage: emptyUsage(),
			runs: [
				{
					id: "subagent-1",
					agent: "explorer",
					description: "Lookup",
					cwd: "",
					model: "provider/model",
					thinking: "low",
					status: "completed",
					activities: [],
					report: "short report",
					usage: emptyUsage(),
				},
			],
		};
		expect(boundSubagentDetails(small)).toEqual(small);
	});

	it("retains the latest three real tool calls when compactions fill the bounded tail", () => {
		const details: SubagentDetails = {
			status: "completed",
			startedAt: 0,
			usage: emptyUsage(),
			runs: [
				{
					id: "subagent-1",
					agent: "explorer",
					description: "Inspect",
					cwd: "",
					model: "provider/model",
					thinking: "low",
					status: "completed",
					activities: [
						...Array.from({ length: 4 }, (_, index) => ({
							id: `read-${index + 1}`,
							toolName: "read",
							summary: `read file-${index + 1}.ts`,
							status: "succeeded" as const,
							startedAt: index,
						})),
						...Array.from({ length: 20 }, (_, index) => ({
							id: `compaction-${index + 1}`,
							toolName: "compaction",
							summary: "Compact context",
							status: "succeeded" as const,
							startedAt: index + 4,
						})),
					],
					report: "Done.",
					usage: { ...emptyUsage(), toolUses: 4 },
				},
			],
		};
		const activities = boundSubagentDetails(details).runs[0]!.activities;
		expect(activities).toHaveLength(DETAILS_ACTIVITY_LIMIT);
		expect(
			activities.filter((activity) => activity.toolName !== "compaction").map((activity) => activity.id),
		).toEqual(["read-2", "read-3", "read-4"]);
		expect(activities.at(-1)?.id).toBe("compaction-20");
	});

	it("bounds aggregate details even when every worker produces large evidence", () => {
		const details: SubagentDetails = {
			status: "failed",
			startedAt: 0,
			usage: { turns: 8, toolUses: 640, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			runs: Array.from({ length: 8 }, (_, index) => ({
				id: `subagent-${index + 1}`,
				agent: `worker-${index + 1}`,
				description: "Inspect the bounded details implementation",
				cwd: "/workspace/".concat("nested/".repeat(2_000)),
				model: "provider/model",
				thinking: "medium",
				status: "failed",
				retry: { attempt: 1, maxAttempts: 3, deadline: 10_000, error: "界".repeat(8_000) },
				activities: Array.from({ length: 80 }, (_, activityIndex) => ({
					id: `tool-${activityIndex}`,
					toolName: "read",
					summary: "界".repeat(1_000),
					status: "failed",
					startedAt: 0,
					resultSummary: "界".repeat(1_000),
				})),
				currentActivity: "界".repeat(2_000),
				report: "界".repeat(32_000),
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
		expect(bounded.runs.every((run) => run.activities.length <= DETAILS_ACTIVITY_LIMIT)).toBe(true);
		expect(
			bounded.runs.every((run) => Buffer.byteLength(run.retry?.error ?? "", "utf8") <= RETRY_ERROR_TEXT_LIMIT),
		).toBe(true);
		expect(bounded.runs.every((run) => Buffer.byteLength(run.report, "utf8") <= TASK_OUTPUT_LIMIT)).toBe(true);
		expect(bounded.runs.every((run) => Buffer.byteLength(run.error ?? "", "utf8") <= TASK_OUTPUT_LIMIT)).toBe(true);
	});
});
