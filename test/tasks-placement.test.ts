import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import type { TaskCompletion, TaskControl, TaskExecution } from "../src/core/tasks/types.ts";
import { settleTask } from "./tasks-settle.ts";

const result = (text = "done") => ({ content: [{ type: "text" as const, text }], details: { ok: true } });
const tick = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function job(overrides: Partial<TaskExecution<{ ok: boolean }>> = {}) {
	const completion = deferred<TaskCompletion<{ ok: boolean }>>();
	let control!: TaskControl<{ ok: boolean }>;
	const run = vi.fn((next: TaskControl<{ ok: boolean }>) => {
		control = next;
		next.accept();
		return completion.promise;
	});
	const execution: TaskExecution<{ ok: boolean }> = {
		kind: "bash",
		title: "test",
		toolCallId: "call",
		run,
		...overrides,
	};
	return {
		execution,
		run,
		completion,
		get control() {
			return control;
		},
	};
}
const lane = { key: "agent", limit: 1 };
const services: TaskRuntime[] = [];
function service(options: ConstructorParameters<typeof TaskRuntime>[0] = {}) {
	const instance = new TaskRuntime({ enabled: true, ...options });
	services.push(instance);
	return instance;
}
afterEach(() => {
	for (const instance of services.splice(0)) instance.close();
});

describe("task placement, display and lanes", () => {
	it.each(["omitted", "given", "failed"] as const)(
		"never carries progress display into a terminal snapshot (completion display %s)",
		async (ending) => {
			const bg = service();
			const item = job({ background: true });
			await bg.execute(item.execution);
			item.control.publish({ result: result("Public progress"), display: "Tool calls\n✓ read entry.ts" });
			expect(bg.get(item.control.id).display?.text).toContain("read entry.ts");
			if (ending === "failed") item.completion.reject(new Error("worker exploded"));
			else
				item.completion.resolve({
					result: result("Final report"),
					...(ending === "given" ? { display: "Tool calls\n✓ done" } : {}),
				});
			await settleTask(bg, item.control.id);
			const task = bg.get(item.control.id);
			if (ending === "given") expect(task.display?.text).toBe("Tool calls\n✓ done");
			else expect(task.display).toBeUndefined();
		},
	);

	describe("caller placement during executor preflight", () => {
		it("keeps a task foreground when setup fails after a detach request answered the caller inline", async () => {
			const runtime = new TaskRuntime({ enabled: true });
			let finishPreflight!: () => void;
			const preflight = new Promise<void>((resolve) => {
				finishPreflight = resolve;
			});
			const call = runtime.execute({
				kind: "probe",
				title: "t",
				toolCallId: "c",
				run: async () => {
					await preflight;
					throw new Error("setup failed before accept");
				},
			});
			expect(runtime.detachForeground()).toBe(1);
			finishPreflight();
			await expect(call).rejects.toThrow("setup failed");
			expect(runtime.list()[0]!.mode).toBe("foreground");
			expect(runtime.list().filter((task) => task.mode === "background")).toEqual([]);
		});

		it("reports background only once the caller is released, and counts a detaching task against admission", async () => {
			const bg = service({ maxBackground: 1 });
			const gate = deferred<TaskCompletion<{ ok: boolean }>>();
			let control!: TaskControl<{ ok: boolean }>;
			const modes: string[] = [];
			const call = bg.execute(
				job({
					run: (next) => {
						control = next;
						next.onModeChange((mode) => modes.push(mode));
						return gate.promise;
					},
				}).execution,
			);
			const id = bg.list()[0]!.id;
			expect(bg.canDetach(id)).toBe(true);
			expect(bg.detachForeground()).toBe(1);
			expect(bg.get(id).mode).toBe("foreground");
			expect(control.mode).toBe("foreground");
			expect(modes).toEqual([]);
			// A detaching task already holds the only background slot and cannot be detached twice.
			expect(bg.canDetach(id)).toBe(false);
			expect(bg.detachForeground()).toBe(0);
			await expect(bg.execute(job({ background: true }).execution)).rejects.toThrow(
				"Background task limit reached (1)",
			);
			control.accept();
			expect((await call).kind).toBe("background");
			expect(bg.get(id).mode).toBe("background");
			expect(control.mode).toBe("background");
			expect(modes).toEqual(["background"]);
			gate.resolve({ result: result() });
			await tick();
		});

		it("leaves a background submission out of the background cohort until it is accepted", async () => {
			const bg = service();
			const gate = deferred<TaskCompletion<{ ok: boolean }>>();
			let control!: TaskControl<{ ok: boolean }>;
			const call = bg.execute(
				job({
					background: true,
					run: (next) => {
						control = next;
						return gate.promise;
					},
				}).execution,
			);
			expect(bg.list()[0]!.mode).toBe("foreground");
			control.accept();
			const outcome = await call;
			expect(outcome).toMatchObject({ kind: "background", reason: "submitted" });
			expect(bg.list()[0]!.mode).toBe("background");
			gate.resolve({ result: result() });
			await tick();
		});

		it("reports why a caller was released to the background", async () => {
			const bg = service();
			const detached = bg.execute(job().execution);
			bg.detachForeground();
			expect(await detached).toMatchObject({ kind: "background", reason: "detached" });
			const submitted = await bg.execute(job({ background: true }).execution);
			expect(submitted).toMatchObject({ kind: "background", reason: "submitted" });
		});
	});

	it("keeps lanes of different executors apart even when they pick the same key", async () => {
		const bg = service();
		const agent = job({ kind: "agent", background: true, concurrency: lane });
		const other = job({ kind: "custom", background: true, concurrency: lane });
		const sameKindQueued = job({ kind: "agent", background: true, concurrency: lane });
		await bg.execute(agent.execution);
		await bg.execute(other.execution);
		const queued = await bg.execute(sameKindQueued.execution);
		expect(agent.run).toHaveBeenCalledOnce();
		expect(other.run).toHaveBeenCalledOnce();
		expect(sameKindQueued.run).not.toHaveBeenCalled();
		expect(queued.kind === "background" && queued.task.status).toBe("queued");
		agent.completion.resolve({ result: result() });
		await vi.waitFor(() => expect(sameKindQueued.run).toHaveBeenCalledOnce());
		other.completion.resolve({ result: result() });
		sameKindQueued.completion.resolve({ result: result() });
		await tick();
	});

	it("evicts settled background records of a standalone runtime, so waited-on work never exhausts admission", async () => {
		const runtime = new TaskRuntime({ enabled: true, maxBackground: 1, maxHistory: 1 });
		services.push(runtime);
		for (let i = 0; i < 20; i++) {
			await runtime.execute({
				kind: "probe",
				title: `job ${i}`,
				toolCallId: `c${i}`,
				background: true,
				run: async (control) => {
					control.accept();
					await new Promise((resolve) => setTimeout(resolve, 1));
					return { result: { content: [{ type: "text", text: "ok" }], details: undefined } };
				},
			});
			await settleTask(runtime, runtime.list().at(-1)!.id);
		}
		expect(runtime.list().length).toBeLessThanOrEqual(1);
	});
});
