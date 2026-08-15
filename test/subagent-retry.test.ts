import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { emptyUsage } from "../src/extensions/subagent/activity.ts";
import { createRunState, getSubagentRetryView, reduceRun } from "../src/extensions/subagent/state.ts";
import type { ResolvedSubagentTask } from "../src/extensions/subagent/types.ts";

function model(): Model<Api> {
	return {
		id: "m",
		name: "m",
		api: "test-api" as Api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	} as Model<Api>;
}

function task(): ResolvedSubagentTask {
	return {
		agent: {
			name: "explorer",
			description: "Read-only exploration",
			tools: ["read"],
			systemPrompt: "Inspect.",
			omitContextFiles: true,
		},
		description: "Inspect retries",
		prompt: "Inspect retries.",
		cwd: process.cwd(),
		model: model(),
		thinking: "low",
	};
}

function runningState(): ReturnType<typeof createRunState> {
	const created = createRunState(task(), 0, undefined, process.cwd());
	return reduceRun(created, { type: "slot_acquired", startedAt: 0 });
}

describe("Subagent provider retry state", () => {
	it("maps provider retry events to a bounded absolute deadline and clears them", () => {
		let run = runningState();
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			deadline: 9_000,
			error: `  fetch   failed\n${"x".repeat(500)}  `,
		});

		expect(run.currentActivity).toBe("Retrying (1/3)…");
		expect(run.retry).toMatchObject({ attempt: 1, maxAttempts: 3, deadline: 9_000 });
		expect(Buffer.byteLength(run.retry?.error ?? "", "utf8")).toBeLessThanOrEqual(160);
		expect(run.retry?.error).not.toMatch(/\s{2,}/u);
		expect(getSubagentRetryView(run, 1_000)?.remainingSeconds).toBe(8);
		expect(getSubagentRetryView(run, 2_000)?.remainingSeconds).toBe(7);
		expect(getSubagentRetryView(run, 8_999)?.remainingSeconds).toBe(1);
		expect(getSubagentRetryView(run, 9_000)?.remainingSeconds).toBe(0);

		run = reduceRun(run, { type: "auto_retry_end" });
		expect(run.retry).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
	});

	it("clears retry state when the provider finishes retrying successfully", () => {
		let run = runningState();
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 3,
			deadline: 3_000,
			error: "temporary overload",
		});
		expect(run.retry).toBeDefined();
		expect(run.currentActivity).toBe("Retrying (2/3)…");

		run = reduceRun(run, { type: "auto_retry_end" });
		expect(run.retry).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
	});

	it("shows the retry line while a task-level backoff is scheduled and clears it on restart", () => {
		let run = runningState();
		run = reduceRun(run, { type: "settle", verdict: "failed", report: "", error: "fetch failed", endedAt: 1 });
		run = reduceRun(run, {
			type: "retry_scheduled",
			attempt: 1,
			maxAttempts: 2,
			deadline: 8_000,
			error: "fetch failed",
		});
		expect(run.status).toBe("queued");
		expect(run.currentActivity).toBe("Retrying (1/2)…");
		expect(getSubagentRetryView(run, 0)?.remainingSeconds).toBe(8);

		run = reduceRun(run, { type: "retry_started" });
		expect(run.retry).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
		expect(run.usage).toEqual(emptyUsage());
	});

	it("normalizes non-finite deadlines and empty retry state defensively", () => {
		let run = runningState();
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: Number.NaN,
			maxAttempts: 0,
			deadline: Number.NaN,
			error: "",
		});
		expect(run.retry?.attempt).toBe(1);
		expect(run.retry?.maxAttempts).toBe(1);
		// A non-finite deadline yields no countdown view, matching the legacy
		// getSubagentRetryView contract.
		expect(getSubagentRetryView(run, 0)).toBeUndefined();
		expect(getSubagentRetryView(createRunState(task(), 0, undefined, process.cwd()))).toBeUndefined();
	});
});
