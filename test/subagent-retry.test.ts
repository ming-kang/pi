import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "../src/extensions/subagent/activity.ts";
import { getSubagentRetryView } from "../src/extensions/subagent/retry.ts";
import { applySubagentAutoRetryEvent } from "../src/extensions/subagent/sdk-runner.ts";
import type { SubagentRunDetails } from "../src/extensions/subagent/types.ts";

function run(): SubagentRunDetails {
	return {
		id: "subagent-1",
		agent: "explorer",
		agentSource: "builtin",
		description: "Inspect retries",
		prompt: "Inspect retry behavior.",
		cwd: "",
		model: "test/model",
		thinking: "low",
		status: "running",
		activities: [],
		liveText: "",
		finalOutput: "",
		usage: emptyUsage(),
	};
}

describe("Subagent provider retry state", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("maps provider retry events to a bounded absolute deadline and clears them", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const details = run();
		applySubagentAutoRetryEvent(details, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 8000,
			errorMessage: `  fetch   failed\n${"x".repeat(500)}  `,
		});

		expect(details.currentActivity).toBe("Retrying (1/3)…");
		expect(details.retry).toMatchObject({ attempt: 1, maxAttempts: 3, deadline: 9000 });
		expect(Buffer.byteLength(details.retry?.error ?? "", "utf8")).toBeLessThanOrEqual(160);
		expect(details.retry?.error).not.toMatch(/\s{2,}/u);
		expect(getSubagentRetryView(details, 1000)?.remainingSeconds).toBe(8);
		expect(getSubagentRetryView(details, 2000)?.remainingSeconds).toBe(7);
		expect(getSubagentRetryView(details, 8999)?.remainingSeconds).toBe(1);
		expect(getSubagentRetryView(details, 9000)?.remainingSeconds).toBe(0);

		applySubagentAutoRetryEvent(details, {
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: "Retry cancelled",
		});
		expect(details.retry).toBeUndefined();
		expect(details.currentActivity).toBeUndefined();
	});
});
