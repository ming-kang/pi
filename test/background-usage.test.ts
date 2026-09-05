import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	BACKGROUND_USAGE_TYPE,
	getAccountedUsages,
	getBackgroundUsageRecord,
	getUsageCostBreakdown,
} from "../src/core/usage-totals.ts";

const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

function ledger(data: unknown) {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(BACKGROUND_USAGE_TYPE, data);
	return manager.getEntries()[0];
}

describe("background usage accounting", () => {
	it("accepts a JSON round-trip including optional provider usage", () => {
		const data = { version: 1, taskId: "group-1", usage: { ...usage, reasoning: 5, cacheWrite1h: 10 } };
		expect(getBackgroundUsageRecord(ledger(JSON.parse(JSON.stringify(data))))).toEqual(data);
	});

	it.each([undefined, null, {}, { version: 2, taskId: "task", usage }, { version: 1, taskId: "", usage }])(
		"ignores malformed records: %j",
		(data) => {
			expect(getBackgroundUsageRecord(ledger(data))).toBeUndefined();
		},
	);

	it.each([NaN, Infinity, -1, "10", null, undefined])("rejects invalid usage fields: %s", (value) => {
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
			expect(
				getBackgroundUsageRecord(ledger({ version: 1, taskId: "task", usage: { ...usage, [field]: value } })),
			).toBeUndefined();
		}
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
			expect(
				getBackgroundUsageRecord(
					ledger({ version: 1, taskId: "task", usage: { ...usage, cost: { ...usage.cost, [field]: value } } }),
				),
			).toBeUndefined();
		}
	});

	it("deduplicates valid task identities without letting an invalid record reserve an identity", () => {
		const entries = [
			ledger({ version: 2, taskId: "task", usage }),
			ledger({ version: 1, taskId: "task", usage }),
			ledger({ version: 1, taskId: "task", usage: { ...usage, input: 999 } }),
			ledger({ version: 1, taskId: "other", usage }),
		];
		expect(getAccountedUsages(entries)).toEqual([usage, usage]);
		expect(getUsageCostBreakdown(entries)).toEqual([{ key: "Tools/summaries", cost: 2, tokens: 200 }]);
	});

	it("mixes legacy and managed results, summaries and ledger records without attributing nested cost to the parent model", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "work", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "parent",
			responseModel: "actual-parent",
			usage,
			stopReason: "stop",
			timestamp: 2,
		});
		const result = {
			role: "toolResult" as const,
			toolCallId: "legacy",
			toolName: "subagent",
			content: [],
			isError: false,
			timestamp: 3,
		};
		manager.appendMessage({ ...result, usage });
		manager.appendMessage({ ...result, toolCallId: "managed" });
		manager.appendCompaction("summary", root, 100, undefined, false, usage);
		manager.branchWithSummary(null, "branch", undefined, false, usage);
		manager.appendCustomEntry(BACKGROUND_USAGE_TYPE, { version: 1, taskId: "managed", usage });
		manager.appendCustomEntry(BACKGROUND_USAGE_TYPE, { version: 1, taskId: "managed", usage });
		expect(getAccountedUsages(manager.getEntries())).toHaveLength(5);
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([
			{ key: "Tools/summaries", cost: 4, tokens: 400 },
			{ key: "anthropic/actual-parent", cost: 1, tokens: 100 },
		]);
		expect(getAccountedUsages(manager.getBranch())).toHaveLength(2);
	});
});
