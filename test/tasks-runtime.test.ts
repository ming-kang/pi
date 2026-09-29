import { describe, expect, it, vi } from "vitest";
import { parseTaskHistory, TASK_HISTORY_VERSION } from "../src/core/tasks/history.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";

function execution(runtime: TaskRuntime, kind: string, signal?: AbortSignal) {
	let control!: TaskControl<undefined>;
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const run = vi.fn(async (next: TaskControl<undefined>) => {
		control = next;
		next.accept();
		await gate;
		return { result: { content: [{ type: "text" as const, text: "finished" }], details: undefined } };
	});
	const outcome = runtime.execute({ kind, title: kind, toolCallId: kind, signal, run });
	return {
		outcome,
		run,
		finish,
		get control() {
			return control;
		},
	};
}

describe("session task runtime", () => {
	it("persists versioned executor-owned view data without renderer callbacks", async () => {
		const runtime = new TaskRuntime();
		const task = execution(runtime, "custom-report");
		const data = { version: 3, data: { findings: [{ file: "a.ts", count: 2 }] } };
		task.control.publishView(data);
		data.data.findings[0]!.count = 99;
		task.finish();
		await task.outcome;
		const saved = JSON.parse(JSON.stringify({ version: TASK_HISTORY_VERSION, task: runtime.get(task.control.id) }));
		expect(parseTaskHistory(saved)?.viewData).toEqual({
			version: 3,
			data: { findings: [{ file: "a.ts", count: 2 }] },
		});
		await runtime.shutdown();
	});
	it("rejects invalid and oversized view data atomically without invoking accessors", async () => {
		const runtime = new TaskRuntime();
		const task = execution(runtime, "custom-report");
		task.control.publishView({ version: 1, data: "previous" });
		const getter = vi.fn(() => "unsafe");
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
		const flags = Object.fromEntries(Array.from({ length: 11000 }, (_, i) => [String(i), true]));
		for (const data of [accessor, { callback: () => {} }, "x".repeat(200_000), { n: Number.NaN }, flags]) {
			expect(() => task.control.publishView({ version: 1, data })).toThrow();
			expect(runtime.get(task.control.id).viewData?.data).toBe("previous");
		}
		expect(getter).not.toHaveBeenCalled();
		task.finish();
		await task.outcome;
		await runtime.shutdown();
	});
	it("keeps executor-private details in the foreground result and out of task history", async () => {
		const runtime = new TaskRuntime({ enabled: true });
		const result = {
			content: [{ type: "text" as const, text: "public report" }],
			details: { privateState: "executor only" },
		};
		const outcome = await runtime.execute({
			kind: "extension-work",
			title: "work",
			toolCallId: "work",
			run: async () => ({ result }),
		});
		expect(outcome).toMatchObject({ kind: "result", result });
		expect(runtime.list()[0]?.result?.details).toBeUndefined();
		await runtime.shutdown();
	});
	it("hands arbitrary extension work off once and releases parent cancellation ownership", async () => {
		const runtime = new TaskRuntime({ enabled: true });
		const parent = new AbortController();
		const task = execution(runtime, "extension-work", parent.signal);
		expect(runtime.detachForeground()).toBe(1);
		expect((await task.outcome).kind).toBe("background");
		parent.abort();
		expect(task.control.signal.aborted).toBe(false);
		task.finish();
		await runtime.wait(task.control.id);
		expect(task.run).toHaveBeenCalledOnce();
		expect(runtime.pendingNotifications()).toMatchObject([{ kind: "extension-work", status: "completed" }]);
		await runtime.shutdown();
	});

	it("retains a watched result without suppressing its completion notification", async () => {
		const runtime = new TaskRuntime({ enabled: true, maxHistory: 0 });
		const task = execution(runtime, "report");
		const release = runtime.retain(task.control.id);
		runtime.detachForeground();
		await task.outcome;
		task.finish();
		await runtime.wait(task.control.id);
		expect(runtime.pendingNotifications()).toMatchObject([{ id: task.control.id }]);
		runtime.markDelivered(task.control.id);
		expect(runtime.get(task.control.id).status).toBe("completed");
		release();
		expect(runtime.list()).toEqual([]);
		await runtime.shutdown();
	});

	it("delivers mode changes only to the affected execution and lets it cancel itself", async () => {
		const runtime = new TaskRuntime({ enabled: true });
		const first = execution(runtime, "first");
		const second = execution(runtime, "second");
		const changed = vi.fn();
		first.control.onModeChange(changed);
		second.control.publish({ content: [], details: undefined });
		expect(changed).not.toHaveBeenCalled();
		runtime.detach(first.control.id);
		await first.outcome;
		expect(changed).toHaveBeenCalledExactlyOnceWith("background");
		first.control.requestCancel();
		expect(first.control.signal.aborted).toBe(true);
		expect(second.control.signal.aborted).toBe(false);
		first.finish();
		second.finish();
		await second.outcome;
		await runtime.shutdown();
	});
});
