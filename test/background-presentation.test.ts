import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { TASK_DETAILS_BYTES, TASK_RESULT_BYTES } from "../src/core/tasks/output.ts";
import {
	readTaskCompletion,
	readTaskProjection,
	taskCompletionMessage,
	taskCompletionSnapshot,
} from "../src/core/tasks/presentation.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskItem, TaskSnapshot } from "../src/core/tasks/types.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "bash-contract-task",
		kind: "bash",
		format: "log",
		mode: "background",
		status: "completed",
		title: "Build",
		toolCallId: "call",
		anchorId: null,
		startedAt: 10,
		endedAt: 20,
		command: "npm run build",
		cwd: "/project",
		outputPath: "/tmp/build.log",
		result: { content: [{ type: "text", text: "tool-formatted result" }], details: { privateData: "opaque" } },
		projection: { shell: { name: "bash", output: { text: "build output", truncated: false } } },
		...overrides,
	};
}
function worker(index: number, text = "report"): TaskItem {
	return {
		id: `worker-${index}`,
		label: `#${index} explorer`,
		category: "explorer",
		description: `task-${index}`,
		status: "completed",
		input: "private input",
		activity: "activity",
		report: { text, truncated: false },
		context: "context",
		usage: "display-only usage",
	};
}

describe("background completion data contract", () => {
	it("captures shell facts independently of tool prose and never exports private details or accounting", () => {
		const serialize = vi.fn();
		const source = task({
			command: "cat <<'EOF'\nOutput: /tmp/example.log\nEOF",
			status: "failed",
			error: "Arbitrary execution failure",
			result: { content: [{ type: "text", text: "unrelated tool formatting" }], details: { toJSON: serialize } },
		});
		const saved = taskCompletionMessage(source);
		expect(saved.details).toEqual({
			version: 1,
			taskId: source.id,
			kind: "bash",
			format: "log",
			title: "Build",
			status: "failed",
			startedAt: 10,
			endedAt: 20,
			shell: "bash",
			command: { text: source.command, truncated: false },
			cwd: "/project",
			outputPath: "/tmp/build.log",
			output: { text: "build output", truncated: false },
			error: "Arbitrary execution failure",
		});
		expect(saved.content).toContain("Arbitrary execution failure");
		expect(saved.content).toContain("Output: /tmp/example.log");
		expect(saved.content).toContain("build output");
		expect(saved.content).not.toContain("unrelated tool formatting");
		expect(saved.details).not.toHaveProperty("result");
		expect(saved.details).not.toHaveProperty("usage");
		expect(saved.details).not.toHaveProperty("anchorId");
		expect(serialize).not.toHaveBeenCalled();
	});

	it("retains a generic projection summary when the final tool result has no text", () => {
		const saved = taskCompletionMessage(
			task({
				id: "subagent-generic",
				kind: "subagent",
				format: "report",
				projection: { text: "Executor summary" },
				result: { content: [], details: undefined },
			}),
		);
		expect(saved.details).toMatchObject({ items: [], output: { text: "Executor summary", truncated: false } });
		expect(saved.content).toContain("Executor summary");
	});

	it("keeps worker errors, reports and observed states distinct and excludes live activity", () => {
		const reports = [worker(1), { ...worker(2, "partial report"), status: "aborted", error: "Stopped by user" }];
		const saved = taskCompletionMessage(
			task({
				id: "subagent-contract-task",
				kind: "subagent",
				format: "report",
				status: "partial",
				projection: { items: reports },
			}),
		);
		expect(saved.details?.kind).toBe("subagent");
		if (saved.details?.format !== "report") throw new Error("Expected group");
		expect(saved.details.items[1]).toMatchObject({
			status: "aborted",
			error: "Stopped by user",
			report: { text: "partial report", truncated: false },
		});
		expect(saved.details.items[0]).not.toHaveProperty("input");
		expect(saved.details.items[0]).not.toHaveProperty("activity");
		expect(saved.details.items[0]).not.toHaveProperty("usage");
		expect(saved.details).not.toHaveProperty("output", expect.anything());
		expect(saved.content).toContain("### 1. task-1");
		expect(saved.content).toContain("### 2. task-2");
		expect(saved.content).toContain("Stopped by user");
		reports[1]!.report.text = "mutated";
		expect(saved.details.items[1]?.report.text).toBe("partial report");
	});

	it("appends a classified next-step hint to non-completed terminal notifications", () => {
		const cancelled = taskCompletionMessage(task({ status: "cancelled" }));
		expect(cancelled.content).toContain(
			"Next step: the task was cancelled — do not restart it unless the user asks.",
		);

		const timedOut = taskCompletionMessage(task({ status: "timeout" }));
		expect(timedOut.content).toContain("Next step: the task hit its timeout");

		const failed = taskCompletionMessage(task({ status: "failed" }));
		expect(failed.content).toContain("Next step: diagnose from the output above");

		const completed = taskCompletionMessage(task({ status: "completed" }));
		expect(completed.content).not.toContain("Next step:");
	});

	it("preserves executor-provided guidance for failed or partial reports", () => {
		const saved = taskCompletionMessage(
			task({
				id: "subagent-group",
				kind: "subagent",
				format: "report",
				status: "partial",
				projection: {
					nextStep:
						"Next step: re-delegate the unfinished work in a fresh subagent call if still needed (task-2).",
					items: [worker(1), { ...worker(2), status: "failed" }],
				},
			}),
		);
		expect(saved.content).toContain(
			"Next step: re-delegate the unfinished work in a fresh subagent call if still needed (task-2).",
		);
	});

	it("carries the process exit code through the completion snapshot", () => {
		const failed = taskCompletionMessage(task({ status: "failed", exitCode: 2 }));
		if (failed.details?.format !== "log") throw new Error("Expected shell");
		expect(failed.details.exitCode).toBe(2);
		// The persisted-message reader round-trips the field.
		expect(readTaskCompletion(JSON.parse(JSON.stringify(failed.details)))).toMatchObject({ exitCode: 2 });

		const reaped = taskCompletionMessage(task({ status: "cancelled", exitCode: null }));
		if (reaped.details?.format !== "log") throw new Error("Expected shell");
		expect(reaped.details.exitCode).toBeNull();

		const unreported = taskCompletionMessage(task());
		if (unreported.details?.format !== "log") throw new Error("Expected shell");
		expect(unreported.details).not.toHaveProperty("exitCode");
		expect(readTaskCompletion({ kind: "bash", format: "log", version: 1, exitCode: "2" })).toBeUndefined();
	});

	it("records truncation when generic results or commands are bounded by supervision", async () => {
		const service = new TaskRuntime({ enabled: true });
		try {
			const literal = "[Output truncated.]";
			await service.execute({
				kind: "bash",
				format: "log",
				title: "Generic",
				toolCallId: "first",
				command: "x".repeat(20000),
				run: async () => ({
					result: { content: [{ type: "text", text: "界".repeat(50000) }], details: undefined },
				}),
			});
			const first = taskCompletionSnapshot(service.list()[0]!);
			expect(first.kind).toBe("bash");
			if (first.format !== "log") throw new Error("Expected shell");
			expect(first.output.truncated).toBe(true);
			expect(first.command?.truncated).toBe(true);
			await service.execute({
				kind: "bash",
				format: "log",
				title: "Literal",
				toolCallId: "second",
				run: async () => ({ result: { content: [{ type: "text", text: literal }], details: undefined } }),
			});
			const second = taskCompletionSnapshot(service.list()[1]!);
			if (second.format !== "log") throw new Error("Expected shell");
			expect(second.output).toEqual({ text: literal, truncated: false });
		} finally {
			service.close();
		}
	});

	it("bounds escaped storage and context text while retaining all eight items", () => {
		const huge = '界🙂"\\\u0001\n'.repeat(30000);
		const reports = Array.from({ length: 8 }, (_, index) => ({
			...worker(index + 1, huge),
			description: `task-${index + 1}${huge}`,
			label: huge,
			category: huge,
			error: huge,
			input: huge,
			activity: huge,
		}));
		const projection = readTaskProjection({ text: huge, items: reports });
		expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(128 * 1024);
		const saved = taskCompletionMessage(
			task({
				id: "subagent-large",
				kind: "subagent",
				format: "report",
				title: huge,
				status: "partial",
				error: huge,
				projection,
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(TASK_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(TASK_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		for (let index = 1; index <= 8; index++) expect(saved.content).toContain(`### ${index}. task-${index}`);
		if (saved.details?.format !== "report") throw new Error("Expected group");
		expect(saved.details.items).toHaveLength(8);
		expect(saved.details.items.every((worker) => worker.report.truncated)).toBe(true);
		expect(reports[0]?.report.truncated).toBe(false);
	});

	it("respects context byte and line budgets with long shell metadata and newline-heavy output", () => {
		const huge = "界\n".repeat(50000);
		const saved = taskCompletionMessage(
			task({
				title: huge,
				command: huge,
				cwd: huge,
				error: huge,
				projection: { shell: { name: "PowerShell", output: { text: huge, truncated: false } } },
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(TASK_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(TASK_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		expect(saved.content).toContain("Saved output truncated");
	});

	it("carries details through the session journal and sends only prose to the context", () => {
		const saved = taskCompletionMessage(task());
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry(saved.customType, saved.content, saved.display, saved.details);
		const entry = JSON.parse(JSON.stringify(manager.getEntry(id)));
		const replay = sessionEntryToContextMessages(entry);
		expect(replay).toHaveLength(1);
		if (replay[0]?.role !== "custom") throw new Error("Expected custom message");
		expect(readTaskCompletion(replay[0].details)).toEqual(saved.details);
		expect(convertToLlm(replay)).toEqual([
			{
				role: "user",
				timestamp: expect.any(Number),
				content: [{ type: "text", text: saved.content }],
			},
		]);
		expect(readTaskCompletion(saved.details)).toEqual(saved.details);
	});

	it("does not call accessors or serializers during decoding and ignores extra private fields", () => {
		const getter = vi.fn();
		const serialize = vi.fn();
		const saved = taskCompletionSnapshot(task());
		expect(readTaskCompletion({ ...saved, toJSON: serialize, privateData: { toJSON: serialize } })).toEqual(saved);
		expect(readTaskCompletion(Object.defineProperty({ ...saved }, "version", { get: getter }))).toBeUndefined();
		const items = [worker(1)];
		Object.defineProperty(items, "0", { get: getter });
		expect(
			readTaskCompletion({
				...saved,
				kind: "subagent",
				format: "report",
				taskId: "subagent-test",
				items: items,
			}),
		).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
		expect(serialize).not.toHaveBeenCalled();
	});

	it.each([
		{ version: 2 },
		{ kind: "worker" },
		{ taskId: "subagent-other" },
		{ taskId: "bash-" },
		{ status: "running" },
		{ startedAt: -1 },
		{ endedAt: 9 },
		{ endedAt: Infinity },
		{ output: { text: "missing flag" } },
		{ command: "not a text snapshot" },
	])("rejects unsupported or incomplete completion metadata: %j", (overrides) => {
		expect(readTaskCompletion({ ...taskCompletionSnapshot(task()), ...overrides })).toBeUndefined();
	});
});
