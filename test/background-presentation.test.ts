import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { TASK_DETAILS_BYTES, TASK_RESULT_BYTES } from "../src/core/tasks/output.ts";
import { readTaskCompletion, taskCompletionMessage, taskCompletionSnapshot } from "../src/core/tasks/presentation.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "bash-contract-task",
		kind: "bash",
		mode: "background",
		status: "completed",
		title: "npm run build",
		toolCallId: "call",
		anchorId: null,
		startedAt: 10,
		endedAt: 20,
		command: "npm run build",
		cwd: "/project",
		outputPath: "/tmp/build.log",
		result: { content: [{ type: "text", text: "build output" }], details: { privateData: "opaque" } },
		...overrides,
	};
}

describe("background completion data contract", () => {
	it("captures shell facts and never exports private details or accounting", () => {
		const serialize = vi.fn();
		const source = task({
			command: "cat <<'EOF'\nOutput: /tmp/example.log\nEOF",
			status: "failed",
			error: "Arbitrary execution failure",
			result: { content: [{ type: "text", text: "build output" }], details: { toJSON: serialize } },
		});
		const saved = taskCompletionMessage(source);
		expect(saved.details).toEqual({
			version: 2,
			taskId: source.id,
			kind: "bash",
			title: "npm run build",
			status: "failed",
			startedAt: 10,
			endedAt: 20,
			command: { text: source.command, truncated: false },
			cwd: "/project",
			outputPath: "/tmp/build.log",
			output: { text: "build output", truncated: false },
			error: "Arbitrary execution failure",
		});
		expect(saved.content).toContain("Arbitrary execution failure");
		expect(saved.content).toContain("Output: /tmp/example.log");
		expect(saved.content).toContain("build output");
		expect(saved.details).not.toHaveProperty("result");
		expect(saved.details).not.toHaveProperty("usage");
		expect(saved.details).not.toHaveProperty("anchorId");
		expect(serialize).not.toHaveBeenCalled();
	});

	it("names a task without a command by its title", () => {
		const saved = taskCompletionMessage(
			task({
				id: "review-generic",
				kind: "review",
				title: "Inspect boundaries",
				command: undefined,
				cwd: undefined,
				outputPath: undefined,
				result: { content: [{ type: "text", text: "Executor summary" }], details: undefined },
			}),
		);
		expect(saved.details).toMatchObject({ title: "Inspect boundaries", output: { text: "Executor summary" } });
		expect(saved.details).not.toHaveProperty("command", expect.anything());
		expect(saved.content).toContain("Background review review-generic: completed — Inspect boundaries");
		expect(saved.content).toContain("Executor summary");
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

	it("carries the process exit code through the completion snapshot", () => {
		const failed = taskCompletionMessage(task({ status: "failed", exitCode: 2 }));
		expect(failed.details?.exitCode).toBe(2);
		// The persisted-message reader round-trips the field.
		expect(readTaskCompletion(JSON.parse(JSON.stringify(failed.details)))).toMatchObject({ exitCode: 2 });

		const reaped = taskCompletionMessage(task({ status: "cancelled", exitCode: null }));
		expect(reaped.details?.exitCode).toBeNull();

		const unreported = taskCompletionMessage(task());
		expect(unreported.details).not.toHaveProperty("exitCode");
		expect(readTaskCompletion({ ...unreported.details, exitCode: "2" })).toBeUndefined();
	});

	it("keeps the end of a long output, where its outcome is", () => {
		const output = `${"progress line\n".repeat(5000)}FINAL: 3 tests failed`;
		const saved = taskCompletionMessage(
			task({ result: { content: [{ type: "text", text: output }], details: undefined } }),
		);
		expect(saved.details?.output.truncated).toBe(true);
		expect(saved.details?.output.text.endsWith("FINAL: 3 tests failed")).toBe(true);
		expect(saved.content).toContain("FINAL: 3 tests failed");
	});

	it("records truncation when results or commands are bounded by supervision", async () => {
		const service = new TaskRuntime({ enabled: true });
		try {
			const literal = "[Output truncated.]";
			await service.execute({
				kind: "bash",
				title: "Generic",
				toolCallId: "first",
				command: "x".repeat(20000),
				run: async () => ({
					result: { content: [{ type: "text", text: "界".repeat(50000) }], details: undefined },
				}),
			});
			const first = taskCompletionSnapshot(service.list()[0]!);
			expect(first.kind).toBe("bash");
			expect(first.output.truncated).toBe(true);
			expect(first.command?.truncated).toBe(true);
			await service.execute({
				kind: "bash",
				title: "Literal",
				toolCallId: "second",
				run: async () => ({ result: { content: [{ type: "text", text: literal }], details: undefined } }),
			});
			const second = taskCompletionSnapshot(service.list()[1]!);
			expect(second.output).toEqual({ text: literal, truncated: false });
		} finally {
			service.close();
		}
	});

	it("respects storage, context byte and line budgets with escape-heavy metadata and output", () => {
		const huge = '界🙂"\\\u0001\n'.repeat(30000);
		const saved = taskCompletionMessage(
			task({
				title: huge,
				command: huge,
				cwd: huge,
				error: huge,
				result: { content: [{ type: "text", text: huge }], details: undefined },
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(TASK_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(TASK_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		expect(saved.content).toContain("[Earlier output truncated; use tasks read for retained task details.]");
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
		expect(readTaskCompletion(Object.defineProperty({ ...saved }, "output", { get: getter }))).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
		expect(serialize).not.toHaveBeenCalled();
	});

	it.each([
		{ version: 1 },
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
