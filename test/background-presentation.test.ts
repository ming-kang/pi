import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_DETAILS_BYTES, BACKGROUND_RESULT_BYTES } from "../src/core/background/output.ts";
import {
	backgroundCompletionMessage,
	backgroundCompletionSnapshot,
	readBackgroundCompletion,
	readBackgroundProjection,
} from "../src/core/background/presentation.ts";
import { BackgroundService } from "../src/core/background/service.ts";
import type { BackgroundTask, BackgroundWorker } from "../src/core/background/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: "bash-contract-task",
		kind: "bash",
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
function worker(index: number, text = "report"): BackgroundWorker {
	return {
		id: `worker-${index}`,
		label: `#${index} explorer`,
		profile: "explorer",
		description: `task-${index}`,
		status: "completed",
		prompt: "private prompt",
		activity: "activity",
		report: { text, truncated: false },
		model: "model",
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
		const saved = backgroundCompletionMessage(source);
		expect(saved.details).toEqual({
			version: 1,
			taskId: source.id,
			kind: "bash",
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
		const saved = backgroundCompletionMessage(
			task({
				id: "subagent-generic",
				kind: "subagent",
				projection: { text: "Executor summary" },
				result: { content: [], details: undefined },
			}),
		);
		expect(saved.details).toMatchObject({ workers: [], output: { text: "Executor summary", truncated: false } });
		expect(saved.content).toContain("Executor summary");
	});

	it("keeps worker errors, reports and observed states distinct and excludes live activity", () => {
		const reports = [worker(1), { ...worker(2, "partial report"), status: "aborted", error: "Stopped by user" }];
		const saved = backgroundCompletionMessage(
			task({
				id: "subagent-contract-task",
				kind: "subagent",
				status: "partial",
				projection: { workers: reports },
			}),
		);
		expect(saved.details?.kind).toBe("subagent");
		if (saved.details?.kind !== "subagent") throw new Error("Expected group");
		expect(saved.details.workers[1]).toMatchObject({
			status: "aborted",
			error: "Stopped by user",
			report: { text: "partial report", truncated: false },
		});
		expect(saved.details.workers[0]).not.toHaveProperty("prompt");
		expect(saved.details.workers[0]).not.toHaveProperty("activity");
		expect(saved.details.workers[0]).not.toHaveProperty("usage");
		expect(saved.details).not.toHaveProperty("output", expect.anything());
		expect(saved.content).toContain("### 1. task-1");
		expect(saved.content).toContain("### 2. task-2");
		expect(saved.content).toContain("Stopped by user");
		reports[1]!.report.text = "mutated";
		expect(saved.details.workers[1]?.report.text).toBe("partial report");
	});

	it("records truncation when generic results or commands are bounded by supervision", async () => {
		const service = new BackgroundService({ enabled: true });
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
			const first = backgroundCompletionSnapshot(service.list()[0]!);
			expect(first.kind).toBe("bash");
			if (first.kind !== "bash") throw new Error("Expected shell");
			expect(first.output.truncated).toBe(true);
			expect(first.command?.truncated).toBe(true);
			await service.execute({
				kind: "bash",
				title: "Literal",
				toolCallId: "second",
				run: async () => ({ result: { content: [{ type: "text", text: literal }], details: undefined } }),
			});
			const second = backgroundCompletionSnapshot(service.list()[1]!);
			if (second.kind !== "bash") throw new Error("Expected shell");
			expect(second.output).toEqual({ text: literal, truncated: false });
		} finally {
			service.close();
		}
	});

	it("bounds escaped storage and model text while retaining all eight workers", () => {
		const huge = '界🙂"\\\u0001\n'.repeat(30000);
		const reports = Array.from({ length: 8 }, (_, index) => ({
			...worker(index + 1, huge),
			description: `task-${index + 1}${huge}`,
			label: huge,
			profile: huge,
			error: huge,
			prompt: huge,
			activity: huge,
		}));
		const projection = readBackgroundProjection({ text: huge, workers: reports });
		expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(128 * 1024);
		const saved = backgroundCompletionMessage(
			task({
				id: "subagent-large",
				kind: "subagent",
				title: huge,
				status: "partial",
				error: huge,
				projection,
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(BACKGROUND_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(BACKGROUND_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		for (let index = 1; index <= 8; index++) expect(saved.content).toContain(`### ${index}. task-${index}`);
		if (saved.details?.kind !== "subagent") throw new Error("Expected group");
		expect(saved.details.workers).toHaveLength(8);
		expect(saved.details.workers.every((worker) => worker.report.truncated)).toBe(true);
		expect(reports[0]?.report.truncated).toBe(false);
	});

	it("respects model byte and line budgets with long shell metadata and newline-heavy output", () => {
		const huge = "界\n".repeat(50000);
		const saved = backgroundCompletionMessage(
			task({
				title: huge,
				command: huge,
				cwd: huge,
				error: huge,
				projection: { shell: { name: "PowerShell", output: { text: huge, truncated: false } } },
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(saved.details))).toBeLessThanOrEqual(BACKGROUND_DETAILS_BYTES);
		expect(Buffer.byteLength(String(saved.content))).toBeLessThanOrEqual(BACKGROUND_RESULT_BYTES);
		expect(String(saved.content).split("\n").length).toBeLessThanOrEqual(2000);
		expect(saved.content).toContain("Saved output truncated");
	});

	it("carries details through the session journal and sends only prose to the model", () => {
		const saved = backgroundCompletionMessage(task());
		const manager = SessionManager.inMemory();
		const id = manager.appendCustomMessageEntry(saved.customType, saved.content, saved.display, saved.details);
		const entry = JSON.parse(JSON.stringify(manager.getEntry(id)));
		const replay = sessionEntryToContextMessages(entry);
		expect(replay).toHaveLength(1);
		if (replay[0]?.role !== "custom") throw new Error("Expected custom message");
		expect(readBackgroundCompletion(replay[0].details)).toEqual(saved.details);
		expect(convertToLlm(replay)).toEqual([
			{
				role: "user",
				timestamp: expect.any(Number),
				content: [{ type: "text", text: saved.content }],
			},
		]);
		expect(readBackgroundCompletion(saved.details)).toEqual(saved.details);
	});

	it("does not call accessors or serializers during decoding and ignores extra private fields", () => {
		const getter = vi.fn();
		const serialize = vi.fn();
		const saved = backgroundCompletionSnapshot(task());
		expect(readBackgroundCompletion({ ...saved, toJSON: serialize, privateData: { toJSON: serialize } })).toEqual(
			saved,
		);
		expect(readBackgroundCompletion(Object.defineProperty({ ...saved }, "version", { get: getter }))).toBeUndefined();
		const items = [worker(1)];
		Object.defineProperty(items, "0", { get: getter });
		expect(
			readBackgroundCompletion({
				...saved,
				kind: "subagent",
				taskId: "subagent-test",
				workers: items,
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
		expect(readBackgroundCompletion({ ...backgroundCompletionSnapshot(task()), ...overrides })).toBeUndefined();
	});
});
