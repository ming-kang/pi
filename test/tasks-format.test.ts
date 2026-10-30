import { afterEach, describe, expect, it, vi } from "vitest";
import { clampWaitMs, TASKS_WAIT_MAX_MS } from "../src/core/tasks/limits.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import { tasksSchema } from "../src/extensions/tasks/tool/schema.ts";
import { formatDuration } from "../src/utils/duration.ts";

afterEach(() => vi.useRealTimers());

describe("task duration formatting", () => {
	it("omits zero components and separates remaining units", () => {
		expect(formatDuration(0)).toBe("<1s");
		expect(formatDuration(499)).toBe("<1s");
		expect(formatDuration(500)).toBe("1s");
		expect(formatDuration(8_000)).toBe("8s");
		expect(formatDuration(59_500)).toBe("1m");
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h 1m");
	});
});

describe("task wait limits", () => {
	it("uses a ten-minute ceiling and human-readable schema guidance", () => {
		expect(TASKS_WAIT_MAX_MS).toBe(10 * 60_000);
		expect(clampWaitMs(600_001)).toBe(600_000);
		expect(clampWaitMs(20_000)).toBe(20_000);
		expect(clampWaitMs(0)).toBe(1_000);
		expect(JSON.stringify(tasksSchema)).toContain("default 20s, max 10m");
	});

	it("keeps the runtime waiting beyond the old one-minute ceiling", async () => {
		vi.useFakeTimers();
		const runtime = new TaskRuntime({ enabled: true });
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const outcome = await runtime.execute({
			kind: "custom",
			title: "long wait",
			toolCallId: "long-wait",
			background: true,
			async run(control) {
				control.accept();
				await gate;
				return { result: { content: [{ type: "text", text: "done" }], details: undefined } };
			},
		});
		if (outcome.kind !== "background") throw new Error("expected a background handoff");
		let settled = false;
		const waiting = runtime.wait(outcome.task.id, { timeoutMs: 600_001 }).then(() => {
			settled = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(60_001);
			expect(settled).toBe(false);
		} finally {
			finish();
			await waiting;
			await runtime.shutdown();
		}
	});
});
