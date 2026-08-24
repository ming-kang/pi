import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { emptyUsage } from "../src/extensions/subagent/activity.ts";
import { ACTIVITY_LIMIT, ACTIVITY_TEXT_LIMIT } from "../src/extensions/subagent/constants.ts";
import {
	appendActivity,
	createRunState,
	deriveCurrentActivity,
	getSubagentRetryView,
	isSubagentError,
	reduceRun,
	type SubagentRunState,
	statusOf,
	statusSummary,
	toRunDetails,
	versionSum,
} from "../src/extensions/subagent/state.ts";
import type { ResolvedSubagentTask, ToolActivity } from "../src/extensions/subagent/types.ts";

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
			tools: ["read", "grep", "find", "ls", "bash"],
			systemPrompt: "Inspect the code.",
			omitContextFiles: true,
		},
		description: "Inspect the reducer",
		prompt: "Inspect the reducer transitions.",
		cwd: process.cwd(),
		model: model(),
		thinking: "low",
	};
}

function state(batchId?: string): SubagentRunState {
	return createRunState(task(), 0, batchId, process.cwd());
}

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		...overrides,
	};
}

describe("subagent run state reducer", () => {
	it("creates a queued run with a stable legacy id and no internal fields leaking", () => {
		const created = state();
		expect(created.status).toBe("queued");
		expect(created.id).toBe("subagent-1");
		const details = toRunDetails(created);
		expect(details).not.toHaveProperty("version");
		expect(details).toEqual({
			id: "subagent-1",
			agent: "explorer",
			description: "Inspect the reducer",
			cwd: "",
			model: "test/m",
			thinking: "low",
			status: "queued",
			activities: [],
			report: "",
			usage: emptyUsage(),
		});
	});

	it("prefixes run ids with a sanitized batchId plus a deterministic hash", () => {
		const first = state("call_ABCdef1234567890GHIjkl456789");
		expect(first.id).toMatch(/^call-ABCdef1234567890GHI-[a-z0-9]{6}-1$/u);
		expect(first.id).toBe(createRunState(task(), 0, "call_ABCdef1234567890GHIjkl456789", process.cwd()).id);
		const second = createRunState(task(), 1, "call_ABCdef1234567890GHIjkl456789", process.cwd());
		expect(second.id.endsWith("-2")).toBe(true);
		const weird = state("toolu_ΩΩ;;;");
		expect(weird.id).toMatch(/^[A-Za-z0-9-]+-1$/u);
		expect(state("!!!").id.startsWith("run-")).toBe(true);
	});

	it("runs the slot lifecycle and bumps the version on every applied event", () => {
		let run = state();
		expect(run.version).toBe(0);
		run = reduceRun(run, { type: "retry_started" });
		expect(run.version).toBe(1);
		run = reduceRun(run, { type: "slot_acquired", startedAt: 1_000 });
		expect(run.status).toBe("running");
		expect(run.startedAt).toBe(1_000);
		expect(run.version).toBe(2);
		expect(versionSum([run])).toBe(2);
	});

	it("accounts usage: turns count, settled messages sum, context is a watermark", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, { type: "turn_end" });
		run = reduceRun(run, { type: "assistant_message_settled", usage: usage() });
		run = reduceRun(run, { type: "assistant_message_settled", usage: usage({ totalTokens: 40 }) });
		run = reduceRun(run, { type: "tool_started", toolCallId: "t1", toolName: "read", args: {}, startedAt: 5 });
		expect(run.usage.turns).toBe(1);
		expect(run.usage.toolUses).toBe(1);
		expect(run.usage.input).toBe(20);
		expect(run.usage.totalTokens).toBe(55);
		expect(run.usage.cost).toBeCloseTo(0.06);
		expect(run.usage.contextTokens).toBe(40);
		// A duplicate settled message must not double-count usage.
		run = reduceRun(run, { type: "assistant_message_settled", usage: undefined });
		expect(run.usage.input).toBe(20);
	});

	it("tracks tool activities start-to-end and derives the current activity line", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "ls" },
			startedAt: 10,
		});
		expect(run.currentActivity).toBe("Run ls");
		run = reduceRun(run, {
			type: "tool_updated",
			toolCallId: "a",
			toolName: "bash",
			args: { command: "git log --oneline" },
		});
		expect(run.activities[0]?.summary).toBe("Run git log --oneline");
		expect(run.currentActivity).toBe("Run git log --oneline");
		run = reduceRun(run, {
			type: "tool_ended",
			toolCallId: "a",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
			endedAt: 20,
		});
		expect(run.activities[0]?.status).toBe("succeeded");
		expect(run.activities[0]?.resultSummary).toBe("ok");
		expect(run.currentActivity).toBeUndefined();
	});

	it("logs auto-compaction as an activity without counting it as a tool use", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "a",
			toolName: "grep",
			args: { pattern: "x" },
			startedAt: 1,
		});
		run = reduceRun(run, {
			type: "tool_ended",
			toolCallId: "a",
			result: { content: [] },
			isError: false,
			endedAt: 2,
		});
		expect(run.usage.toolUses).toBe(1);

		run = reduceRun(run, { type: "compaction_started", startedAt: 3 });
		expect(run.activities).toHaveLength(2);
		expect(run.currentActivity).toBe("Compacting context…");
		// Compaction is not a tool call.
		expect(run.usage.toolUses).toBe(1);

		run = reduceRun(run, {
			type: "compaction_ended",
			tokensBefore: 244_000,
			tokensAfter: 48_000,
			error: undefined,
			endedAt: 4,
		});
		expect(run.activities[1]).toMatchObject({
			status: "succeeded",
			summary: "Compacted 244k → 48k",
			endedAt: 4,
		});
		expect(run.activities[1]?.resultSummary).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
		expect(run.usage.toolUses).toBe(1);
	});

	it("surfaces a failed compaction's reason on the activity entry", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, { type: "compaction_started", startedAt: 1 });
		run = reduceRun(run, {
			type: "compaction_ended",
			tokensBefore: undefined,
			tokensAfter: undefined,
			error: "Auto-compaction failed: Nothing to compact\n  while preserving the recent context.",
			endedAt: 2,
		});
		expect(run.activities[0]).toMatchObject({
			status: "failed",
			summary: "Compact context",
			resultSummary: "Auto-compaction failed: Nothing to compact while preserving the recent context.",
		});
		expect(run.currentActivity).toBeUndefined();
	});

	it("ends the newest running compaction when a worker compacts more than once", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, { type: "compaction_started", startedAt: 1 });
		run = reduceRun(run, {
			type: "compaction_ended",
			tokensBefore: 200_000,
			tokensAfter: 40_000,
			error: undefined,
			endedAt: 2,
		});
		run = reduceRun(run, { type: "compaction_started", startedAt: 3 });
		run = reduceRun(run, {
			type: "compaction_ended",
			tokensBefore: undefined,
			tokensAfter: undefined,
			error: "Auto-compaction failed: boom",
			endedAt: 4,
		});
		expect(run.activities).toHaveLength(2);
		// The first entry keeps its own outcome.
		expect(run.activities[0]).toMatchObject({ status: "succeeded", summary: "Compacted 200k → 40k" });
		expect(run.activities[1]).toMatchObject({ status: "failed", resultSummary: "Auto-compaction failed: boom" });
	});

	it("keeps the current activity on the still-running tool when parallel tools end out of order", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "a",
			toolName: "read",
			args: { path: "a.ts" },
			startedAt: 1,
		});
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "b",
			toolName: "grep",
			args: { pattern: "x" },
			startedAt: 2,
		});
		expect(run.currentActivity).toBe("Search x");
		const beforeEndVersion = versionSum([run]);
		run = reduceRun(run, {
			type: "tool_ended",
			toolCallId: "b",
			result: { content: [] },
			isError: false,
			endedAt: 3,
		});
		// The historical implementation cleared the line here; the derived
		// line must fall back to the still-running tool. The run revision must
		// also move even though the last activity remains unchanged.
		expect(versionSum([run])).toBeGreaterThan(beforeEndVersion);
		expect(run.currentActivity).toBe("read a.ts");
		expect(deriveCurrentActivity(run)).toBe("read a.ts");
	});

	it("updates the matching running activity for tool updates", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "a",
			toolName: "read",
			args: { path: "a.ts" },
			startedAt: 1,
		});
		run = reduceRun(run, {
			type: "tool_started",
			toolCallId: "b",
			toolName: "read",
			args: { path: "b.ts" },
			startedAt: 2,
		});
		run = reduceRun(run, { type: "tool_updated", toolCallId: "a", toolName: "read", args: { path: "a2.ts" } });
		expect(run.activities[0]?.summary).toBe("read a2.ts");
		expect(run.activities[1]?.summary).toBe("read b.ts");
	});

	it("bounds the activity log by count, evicting oldest first", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		for (let index = 0; index < 200; index++) {
			run = reduceRun(run, {
				type: "tool_started",
				toolCallId: `tool-${index}`,
				toolName: "read",
				args: { path: `file-${index}.ts` },
				startedAt: index,
			});
		}
		expect(run.activities.length).toBeLessThanOrEqual(ACTIVITY_LIMIT);
		expect(run.activities.at(-1)?.id).toBe("tool-199");
	});

	it("keeps the activity text budget by evicting oldest entries (defensive path)", () => {
		// Real events bound every summary, so the text budget is driven
		// directly through the shared appendActivity helper.
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

	it("maps task retry scheduling onto the historical reset matrix", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 100 });
		run = reduceRun(run, {
			type: "settle",
			verdict: "failed",
			report: "",
			error: "fetch failed",
			endedAt: 200,
		});
		run = reduceRun(run, {
			type: "retry_scheduled",
			attempt: 1,
			maxAttempts: 2,
			deadline: 9_000,
			error: undefined,
		});
		expect(run.status).toBe("queued");
		expect(run.startedAt).toBeUndefined();
		expect(run.endedAt).toBeUndefined();
		expect(run.report).toBe("");
		expect(run.activities).toHaveLength(0);
		expect(run.usage).toEqual(emptyUsage());
		expect(run.retry).toMatchObject({ attempt: 1, maxAttempts: 2, deadline: 9_000, error: "fetch failed" });
		expect(run.currentActivity).toBe("Retrying (1/2)…");
		run = reduceRun(run, { type: "retry_started" });
		expect(run.retry).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
	});

	it("falls back to a bounded default error when scheduling a retry without one", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, { type: "settle", verdict: "failed", report: "", error: undefined, endedAt: 1 });
		run = reduceRun(run, { type: "retry_scheduled", attempt: 1, maxAttempts: 2, deadline: 10, error: undefined });
		expect(run.retry?.error).toBe("Subagent failed before retry.");
	});

	it("maps provider auto-retry events to a bounded countdown and clears them", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			deadline: 9_000,
			error: `  fetch   failed\n${"x".repeat(500)}  `,
		});
		expect(run.retry).toMatchObject({ attempt: 1, maxAttempts: 3, deadline: 9_000 });
		expect(Buffer.byteLength(run.retry?.error ?? "", "utf8")).toBeLessThanOrEqual(160);
		expect(run.retry?.error).not.toMatch(/\s{2,}/u);
		expect(run.currentActivity).toBe("Retrying (1/3)…");
		expect(getSubagentRetryView(run, 1_000)?.remainingSeconds).toBe(8);
		expect(getSubagentRetryView(run, 8_999)?.remainingSeconds).toBe(1);
		expect(getSubagentRetryView(run, 9_000)?.remainingSeconds).toBe(0);
		run = reduceRun(run, { type: "auto_retry_end" });
		expect(run.retry).toBeUndefined();
		expect(run.currentActivity).toBeUndefined();
	});

	it("normalizes non-finite provider retry values defensively", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: Number.NaN,
			maxAttempts: 0,
			deadline: Number.NaN,
			error: "",
		});
		expect(run.retry?.attempt).toBe(1);
		expect(run.retry?.maxAttempts).toBe(1);
		expect(getSubagentRetryView(run, 0)).toBeUndefined();
	});

	it("returns no retry view for a run without retry state", () => {
		expect(getSubagentRetryView(state())).toBeUndefined();
	});

	it("settles with bounded report and error, clears pending retry state, then ignores further events", () => {
		let run = state();
		run = reduceRun(run, { type: "slot_acquired", startedAt: 0 });
		run = reduceRun(run, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			deadline: 10_000,
			error: "overloaded",
		});
		expect(run.retry).toBeDefined();
		run = reduceRun(run, {
			type: "settle",
			verdict: "failed",
			report: "x".repeat(100_000),
			error: "e".repeat(20_000),
			endedAt: 5_000,
		});
		expect(run.status).toBe("failed");
		expect(run.endedAt).toBe(5_000);
		expect(run.retry).toBeUndefined();
		expect(Buffer.byteLength(run.report, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(Buffer.byteLength(run.error ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
		expect(run.currentActivity).toBeUndefined();
		const settledVersion = run.version;
		run = reduceRun(run, { type: "turn_end" });
		run = reduceRun(run, { type: "slot_acquired", startedAt: 9_999 });
		run = reduceRun(run, { type: "abort_while_queued", endedAt: 9_999 });
		expect(run.version).toBe(settledVersion);
		expect(run.status).toBe("failed");
		expect(run.startedAt).toBe(0);
	});

	it("applies the fixed abort verdicts for queued and retrying runs", () => {
		let queued = state();
		queued = reduceRun(queued, { type: "abort_while_queued", endedAt: 42 });
		expect(queued.status).toBe("aborted");
		expect(queued.error).toBe("Subagent was aborted while queued.");
		expect(queued.endedAt).toBe(42);

		let retrying = state();
		retrying = reduceRun(retrying, { type: "slot_acquired", startedAt: 0 });
		retrying = reduceRun(retrying, {
			type: "settle",
			verdict: "failed",
			report: "",
			error: "fetch failed",
			endedAt: 1,
		});
		retrying = reduceRun(retrying, {
			type: "retry_scheduled",
			attempt: 1,
			maxAttempts: 2,
			deadline: 10,
			error: "fetch failed",
		});
		retrying = reduceRun(retrying, { type: "abort_while_retrying", endedAt: 50 });
		expect(retrying.status).toBe("aborted");
		expect(retrying.error).toBe("Subagent was aborted while waiting to retry.");
		expect(retrying.retry).toBeUndefined();
		expect(retrying.currentActivity).toBeUndefined();
	});

	it("keeps batch selectors on details shapes", () => {
		const queued = state();
		const running = reduceRun(state(), { type: "slot_acquired", startedAt: 0 });
		const completed = reduceRun(running, {
			type: "settle",
			verdict: "completed",
			report: "ok",
			error: undefined,
			endedAt: 2,
		});
		const failed = reduceRun(running, { type: "settle", verdict: "failed", report: "", error: "boom", endedAt: 2 });
		const aborted = reduceRun(running, {
			type: "settle",
			verdict: "aborted",
			report: "",
			error: "aborted",
			endedAt: 2,
		});
		expect(statusOf([])).toBe("running");
		expect(statusOf([queued, completed])).toBe("running");
		expect(statusOf([completed])).toBe("completed");
		expect(statusOf([completed, failed])).toBe("partial");
		expect(statusOf([failed])).toBe("failed");
		expect(statusSummary({ status: "running", runs: [], startedAt: 0, usage: emptyUsage() })).toBe("Initializing…");
		expect(
			statusSummary({
				status: "running",
				startedAt: 0,
				usage: emptyUsage(),
				runs: [toRunDetails(queued)],
			}),
		).toBe("0/1 complete · 1 queued");
		expect(
			statusSummary({
				status: "running",
				startedAt: 0,
				usage: emptyUsage(),
				runs: [toRunDetails(completed), toRunDetails(running), toRunDetails(failed), toRunDetails(aborted)],
			}),
		).toBe("1/4 complete · 1 running · 1 failed · 1 aborted");
		expect(
			statusSummary({
				status: "failed",
				startedAt: 0,
				usage: emptyUsage(),
				runs: [toRunDetails(completed), toRunDetails(failed)],
			}),
		).toBe("1/2 complete · 1 failed");
		expect(isSubagentError({ status: "failed", runs: [toRunDetails(failed)] })).toBe(true);
		expect(isSubagentError({ status: "failed", runs: [toRunDetails(completed), toRunDetails(failed)] })).toBe(false);
		expect(isSubagentError({ status: "aborted", runs: [toRunDetails(aborted)] })).toBe(true);
		expect(isSubagentError({ status: "completed", runs: [toRunDetails(completed)] })).toBe(false);
	});
});
