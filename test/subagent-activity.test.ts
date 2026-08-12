import { describe, expect, it } from "vitest";
import {
	addUsage,
	appendActivity,
	boundText,
	emptyUsage,
	mergeUsage,
	tailText,
	toNestedUsage,
} from "../src/extensions/subagent/activity.ts";
import {
	ACTIVITY_LIMIT,
	ACTIVITY_TEXT_LIMIT,
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	RETRY_ERROR_TEXT_LIMIT,
	TASK_OUTPUT_LIMIT,
} from "../src/extensions/subagent/constants.ts";
import { boundSubagentDetails } from "../src/extensions/subagent/runner.ts";
import type { SubagentDetails, SubagentUsage, ToolActivity } from "../src/extensions/subagent/types.ts";

describe("subagent output bounds", () => {
	it("never exceeds the requested UTF-8 byte budget, including the truncation notice", () => {
		for (const limit of [1, 8, 32, 64, 256]) {
			const bounded = boundText("界".repeat(1_000), limit);
			expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(limit);
		}
	});

	it("keeps tail truncation Unicode-safe and inside the total UTF-8 budget", () => {
		const input = `😀${"é".repeat(23)}${"a".repeat(975)}`;
		const bounded = tailText(input, 1_024);
		expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(1_024);
		expect(bounded).toContain("[Earlier output omitted.]\n");
		expect(
			Array.from(bounded).some((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint >= 0xd800 && codePoint <= 0xdfff;
			}),
		).toBe(false);

		const latest = tailText(`${"old ".repeat(100)}😀最终`, 64);
		expect(latest).toMatch(/😀最终$/u);
		for (const limit of [0, 1, 8, 24, 25, 26, 32]) {
			expect(Buffer.byteLength(tailText("界".repeat(1_000), limit), "utf8")).toBeLessThanOrEqual(limit);
		}
	});

	it("keeps activity lists within the per-run activity limits", () => {
		const activities: ToolActivity[] = [];
		for (let index = 0; index < 200; index++) {
			appendActivity(activities, {
				id: `tool-${index}`,
				toolName: "read",
				summary: `read ${index}.ts`,
				status: "succeeded",
				startedAt: index,
			});
		}
		expect(activities.length).toBeLessThanOrEqual(ACTIVITY_LIMIT);
		expect(activities.at(-1)?.id).toBe("tool-199");
	});

	it("drops the oldest activities while summaries exceed the text budget", () => {
		const activities: ToolActivity[] = [];
		for (let index = 0; index < 40; index++) {
			appendActivity(activities, {
				id: `tool-${index}`,
				toolName: "read",
				summary: "x".repeat(2_000),
				status: "running",
				startedAt: index,
			});
		}
		const total = activities.reduce((sum, activity) => sum + activity.summary.length, 0);
		expect(total).toBeLessThanOrEqual(ACTIVITY_TEXT_LIMIT);
		expect(activities[0]?.id).not.toBe("tool-0");
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
