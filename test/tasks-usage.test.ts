import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { readTaskUsage, TASK_RECORD_TYPE } from "../src/core/tasks/codec.ts";
import { TaskSession } from "../src/core/tasks/session.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { getAccountedUsages, getUsageCostBreakdown } from "../src/core/usage-totals.ts";

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
	manager.appendCustomEntry(TASK_RECORD_TYPE, data);
	return manager.getEntries()[0];
}
const record = (id: string, value: unknown = usage, version = 3) => ({ version, task: { id }, usage: value });

describe("background usage accounting", () => {
	it("does not bill a restored session's task again, even from another branch", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-task-usage-"));
		let host: TaskSession | undefined;
		try {
			const saved = SessionManager.inMemory();
			const root = saved.appendCustomEntry("root", {});
			saved.appendCustomEntry(TASK_RECORD_TYPE, record("restored"));
			saved.branch(root);
			saved.appendCustomEntry("other-branch", {});
			const file = join(dir, "session.jsonl");
			await writeFile(
				file,
				[saved.getHeader(), ...saved.getEntries()].map((entry) => JSON.stringify(entry)).join("\n"),
			);
			const manager = SessionManager.open(file, dir);
			host = new TaskSession({
				manager,
				canDeliver: () => false,
				deliver: async () => {},
				onEntry: () => {},
				onError: () => {},
			});
			const before = getUsageCostBreakdown(manager.getEntries());
			const task: TaskSnapshot = {
				id: "restored",
				kind: "bash",
				label: "Bash",
				title: "restored",
				output: "log",
				toolCallId: "call",
				anchorId: null,
				mode: "foreground",
				status: "completed",
				startedAt: 1,
				endedAt: 2,
			};
			(host as unknown as { persistSettlement(task: TaskSnapshot, usage: Usage): void }).persistSettlement(
				task,
				usage,
			);
			expect(manager.getEntries().filter((entry) => readTaskUsage(entry)?.taskId === task.id)).toHaveLength(1);
			expect(getUsageCostBreakdown(manager.getEntries())).toEqual(before);
		} finally {
			host?.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("accepts a JSON round-trip including optional provider usage", () => {
		const data = record("group-1", { ...usage, reasoning: 5, cacheWrite1h: 10 });
		expect(readTaskUsage(ledger(JSON.parse(JSON.stringify(data))))).toEqual({
			taskId: "group-1",
			usage: data.usage,
		});
	});

	it.each([
		{},
		record("task", usage, 2),
		record(""),
		{ version: 3, task: { id: "task" } },
		record("task", { ...usage, input: -1 }),
		record("task", { ...usage, cost: { ...usage.cost, total: Number.NaN } }),
	])("ignores malformed records: %j", (data) => {
		expect(readTaskUsage(ledger(data))).toBeUndefined();
	});

	it("keeps billing usage that released sessions settled in separate entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("task-usage", { version: 1, taskId: "released", usage });
		manager.appendCustomEntry("task-usage", { version: 2, taskId: "unknown", usage });
		manager.appendCustomEntry(TASK_RECORD_TYPE, record("released"));
		manager.appendCustomEntry(TASK_RECORD_TYPE, record("current"));
		expect(getAccountedUsages(manager.getEntries())).toEqual([usage, usage]);
	});

	it("deduplicates valid task identities without letting an invalid record reserve an identity", () => {
		const entries = [
			ledger(record("task", usage, 2)),
			ledger(record("task")),
			ledger(record("task", { ...usage, input: 999 })),
			ledger(record("other")),
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
		manager.appendCustomEntry(TASK_RECORD_TYPE, record("managed"));
		manager.appendCustomEntry(TASK_RECORD_TYPE, record("managed"));
		expect(getAccountedUsages(manager.getEntries())).toHaveLength(5);
		expect(getUsageCostBreakdown(manager.getEntries())).toEqual([
			{ key: "Tools/summaries", cost: 4, tokens: 400 },
			{ key: "anthropic/actual-parent", cost: 1, tokens: 100 },
		]);
		expect(getAccountedUsages(manager.getBranch())).toHaveLength(2);
	});
});
