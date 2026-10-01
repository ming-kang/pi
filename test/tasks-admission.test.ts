import { afterEach, describe, expect, it } from "vitest";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskControl } from "../src/core/tasks/types.ts";

const runtimes: TaskRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

function create(maxActive = 2) {
	const runtime = new TaskRuntime({ enabled: true, maxActive });
	runtimes.push(runtime);
	return runtime;
}

/** Work that runs until its control is cancelled. */
function start(runtime: TaskRuntime, name: string, background: boolean) {
	let control!: TaskControl<undefined>;
	const outcome = runtime.execute({
		kind: "bash",
		title: name,
		toolCallId: name,
		background,
		run: (next) => {
			control = next;
			next.accept();
			return new Promise((resolve) =>
				next.signal.addEventListener("abort", () =>
					resolve({ status: "cancelled", result: { content: [], details: undefined } }),
				),
			);
		},
	});
	return {
		outcome,
		get control() {
			return control;
		},
	};
}

describe("task admission", () => {
	it("runs foreground commands while background work fills every slot", async () => {
		const runtime = create();
		await start(runtime, "server-1", true).outcome;
		await start(runtime, "server-2", true).outcome;
		const outcome = await runtime.execute({
			kind: "bash",
			title: "ls",
			toolCallId: "ls",
			run: async () => ({ result: { content: [{ type: "text", text: "ok" }], details: undefined } }),
		});
		expect(outcome).toMatchObject({ kind: "result" });
	});

	it("rejects a third background submission with a background-specific reason", async () => {
		const runtime = create();
		await start(runtime, "server-1", true).outcome;
		await start(runtime, "server-2", true).outcome;
		await expect(start(runtime, "server-3", true).outcome).rejects.toThrow(/Background task limit reached \(2\)/);
	});

	it("does not count running foreground work against background admission", async () => {
		const runtime = create();
		const foreground = [start(runtime, "test-1", false), start(runtime, "test-2", false)];
		await expect(start(runtime, "server", true).outcome).resolves.toMatchObject({ kind: "background" });
		for (const task of foreground) task.control.requestCancel();
	});

	it("detaches only as many foreground tasks as background slots allow", async () => {
		const runtime = create();
		await start(runtime, "server", true).outcome;
		const first = start(runtime, "test-1", false);
		const second = start(runtime, "test-2", false);
		await Promise.resolve();
		expect(runtime.detachForeground()).toBe(1);
		expect(runtime.list().filter((task) => task.mode === "background")).toHaveLength(2);
		expect(() => runtime.detachForeground()).toThrow(/Background task limit reached \(2\)/);
		expect(() => runtime.detach(second.control.id)).toThrow(/Background task limit reached \(2\)/);
		first.control.requestCancel();
		second.control.requestCancel();
	});
});

describe("task snapshots", () => {
	it("returns a stable snapshot until the task changes", async () => {
		const runtime = create();
		const task = start(runtime, "build", true);
		await task.outcome;
		const id = task.control.id;
		expect(runtime.get(id)).toBe(runtime.get(id));
		expect(Object.isFrozen(runtime.get(id))).toBe(true);
		const before = runtime.get(id);
		task.control.publish({ content: [{ type: "text", text: "progress" }], details: undefined });
		expect(runtime.get(id)).not.toBe(before);
		expect(runtime.get(id).result?.content).toEqual([{ type: "text", text: "progress" }]);
		task.control.requestCancel();
		await runtime.wait(id);
		expect(runtime.get(id).status).toBe("cancelled");
	});
});
