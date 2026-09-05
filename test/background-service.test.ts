import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_DETAILS_BYTES,
	BACKGROUND_RESULT_BYTES,
	boundedResult,
	boundText,
	readOutputSlice,
} from "../src/core/background/output.ts";
import { BackgroundService } from "../src/core/background/service.ts";
import {
	type BackgroundCompletion,
	type BackgroundControl,
	type BackgroundExecution,
	type BackgroundTask,
	SUBAGENT_BACKGROUND_REJECTION,
} from "../src/core/background/types.ts";

const result = (text = "done"): AgentToolResult<{ ok: boolean }> => ({
	content: [{ type: "text", text }],
	details: { ok: true },
});
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
function job(overrides: Partial<BackgroundExecution<{ ok: boolean }>> = {}) {
	const completion = deferred<BackgroundCompletion<{ ok: boolean }>>();
	let control!: BackgroundControl<{ ok: boolean }>;
	const run = vi.fn((next: BackgroundControl<{ ok: boolean }>) => {
		control = next;
		next.accept();
		return completion.promise;
	});
	const execution: BackgroundExecution<{ ok: boolean }> = {
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
const services: BackgroundService[] = [];
function service(options: ConstructorParameters<typeof BackgroundService>[0] = {}) {
	const instance = new BackgroundService({ enabled: true, ...options });
	services.push(instance);
	return instance;
}
afterEach(() => {
	for (const instance of services.splice(0)) instance.close();
	vi.useRealTimers();
});

describe("BackgroundService execution ownership", () => {
	it("atomically detaches every silent foreground invocation exactly once", async () => {
		const bg = service();
		const parent = new AbortController();
		const update = vi.fn();
		const jobs = [job({ signal: parent.signal, onUpdate: update }), job({ kind: "subagent", signal: parent.signal })];
		const calls = jobs.map((item) => bg.execute(item.execution));
		jobs[0]!.control.publish(result("progress"));
		const observed: string[][] = [];
		bg.subscribe(() => {
			observed.push(bg.list().map((task) => task.mode));
		});
		expect(bg.detachForeground()).toBe(2);
		expect(bg.detachForeground()).toBe(0);
		expect(observed.every((modes) => modes.every((mode) => mode === "background"))).toBe(true);
		expect((await Promise.all(calls)).map((outcome) => outcome.kind)).toEqual(["background", "background"]);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
		parent.abort();
		jobs[0]!.control.publish(result("late"));
		expect(update).toHaveBeenCalledTimes(1);
		for (const item of jobs) {
			expect(item.control.signal.aborted).toBe(false);
			expect(item.run).toHaveBeenCalledTimes(1);
			item.completion.resolve({ result: result() });
		}
		await tick();
		expect(bg.pendingNotifications()).toHaveLength(2);
	});

	it("waits for explicit whole-invocation acceptance after detach", async () => {
		const bg = service();
		const gate = deferred<BackgroundCompletion<{ ok: boolean }>>();
		let control!: BackgroundControl<{ ok: boolean }>;
		const parent = new AbortController();
		const settled = vi.fn();
		const call = bg.execute(
			job({
				signal: parent.signal,
				run: (next) => {
					control = next;
					return gate.promise;
				},
			}).execution,
		);
		void call.then(settled);
		expect(bg.detachForeground()).toBe(1);
		await tick();
		expect(settled).not.toHaveBeenCalled();
		expect(control.signal.aborted).toBe(false);
		control.accept();
		expect((await call).kind).toBe("background");
		gate.resolve({ result: result() });
		await tick();
	});

	it.each([false, true])("preserves synchronous preflight exceptions, background=%s", async (background) => {
		const bg = service();
		const error = new Error("whole batch rejected");
		await expect(
			bg.execute(
				job({
					background,
					run: () => {
						throw error;
					},
				}).execution,
			),
		).rejects.toBe(error);
		expect(bg.list()[0]).toMatchObject({ status: "failed", error: error.message });
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("preserves async preflight failure after a detach request", async () => {
		const bg = service();
		const gate = deferred<BackgroundCompletion<{ ok: boolean }>>();
		const call = bg.execute(job({ run: () => gate.promise }).execution);
		const rejected = expect(call).rejects.toThrow("preflight");
		bg.detachForeground();
		gate.reject(new Error("preflight"));
		await rejected;
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("does not require acceptance to return a foreground result and never mistakes progress for completion", async () => {
		const bg = service();
		const item = job();
		const call = bg.execute(item.execution);
		item.control.publish(result("apparently done"));
		expect(bg.get(item.control.id).status).toBe("running");
		item.completion.resolve({ result: result("authoritative"), status: "partial" });
		expect(await call).toEqual({
			kind: "result",
			result: result("authoritative"),
			status: "partial",
			error: undefined,
		});
		expect(bg.get(item.control.id).status).toBe("partial");
		expect(bg.detachForeground()).toBe(0);
		expect(bg.pendingNotifications()).toEqual([]);
		const direct = await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
		expect(direct.kind).toBe("result");
	});

	it("prefers an immediately available completion over initial handoff", async () => {
		const bg = service();
		const outcome = await bg.execute(
			job({
				background: true,
				run: async (control) => {
					control.accept();
					return { result: result() };
				},
			}).execution,
		);
		expect(outcome.kind).toBe("result");
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("starts no executor for pre-aborted, disabled, closed or worker admission", async () => {
		const parent = new AbortController();
		parent.abort(new Error("already cancelled"));
		const item = job({ signal: parent.signal });
		await expect(service().execute(item.execution)).rejects.toThrow("already cancelled");
		await expect(service({ enabled: false }).execute(job().execution)).rejects.toThrow("not available");
		const worker = service({ role: "subagent" });
		worker.setEnabled(true);
		expect(worker.enabled).toBe(false);
		await expect(worker.execute(item.execution)).rejects.toThrow(SUBAGENT_BACKGROUND_REJECTION);
		const closed = service();
		closed.close();
		closed.setEnabled(true);
		await expect(closed.execute(item.execution)).rejects.toThrow("closed");
		expect(item.run).not.toHaveBeenCalled();
	});

	it("parent abort cancels only an attached executor, kill is idempotent and stopping is not terminal", async () => {
		const bg = service();
		const parent = new AbortController();
		const item = job({ signal: parent.signal });
		const call = bg.execute(item.execution);
		parent.abort();
		expect(item.control.signal.aborted).toBe(true);
		expect(bg.get(item.control.id).status).toBe("stopping");
		expect(bg.kill(item.control.id)).toBe(false);
		item.completion.resolve({ result: result("partial output") });
		await call;
		expect(bg.get(item.control.id).status).toBe("cancelled");
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
	});

	it("records useful background exceptions without a second caller rejection", async () => {
		const bg = service();
		const item = job({ background: true });
		expect((await bg.execute(item.execution)).kind).toBe("background");
		item.completion.reject(new Error("worker exploded"));
		await tick();
		expect(bg.pendingNotifications()[0]).toMatchObject({ status: "failed", error: "worker exploded" });
		expect((await bg.read(item.control.id)).text).toContain("worker exploded");
	});

	it("ignores late updates and isolates observer exceptions", async () => {
		const bg = service();
		bg.subscribe(() => {
			throw new Error("broken panel");
		});
		const listener = vi.fn();
		const unsubscribe = bg.subscribe(listener);
		const item = job({
			onUpdate: () => {
				throw new Error("broken tool row");
			},
		});
		const call = bg.execute(item.execution);
		item.control.publish(result("progress"));
		item.completion.resolve({ result: result("final") });
		await call;
		const count = listener.mock.calls.length;
		item.control.publish(result("late"));
		item.control.setOutputPath("late-path");
		expect(listener).toHaveBeenCalledTimes(count);
		expect(bg.get(item.control.id).result).toEqual(result("final"));
		unsubscribe();
	});
});

describe("delivery and accounting", () => {
	it("settles usage once before terminal delivery, strips it from snapshots and foreground results", async () => {
		const usage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		};
		let bg!: BackgroundService;
		const onSettled = vi.fn(() => {
			expect(bg.pendingNotifications()).toEqual([]);
		});
		bg = service({ onSettled });
		const item = job();
		const call = bg.execute(item.execution);
		item.control.publish({ ...result(), usage });
		expect(bg.get(item.control.id).result?.usage).toBeUndefined();
		item.completion.resolve({ result: { ...result(), usage } });
		expect(await call).toEqual({ kind: "result", result: result(), status: "completed", error: undefined });
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(onSettled.mock.calls[0]).toEqual([expect.objectContaining({ result: result() }), usage]);
		await bg.read(item.control.id);
		await bg.wait(item.control.id);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("makes accounting persistence errors visible without unhandled rejections", async () => {
		const bg = service({
			onSettled: () => {
				throw new Error("disk full");
			},
		});
		const item = job({ background: true });
		await bg.execute(item.execution);
		item.completion.resolve({ result: result("report") });
		await tick();
		expect(bg.pendingNotifications()[0]?.error).toContain("Usage settlement failed: disk full");
		expect((await bg.read(item.control.id)).text).toContain("disk full");
	});

	it("supports nested pause, claims, release and delivered states without pausing execution", async () => {
		const bg = service();
		const first = bg.pause();
		const second = bg.pause();
		const item = job({ background: true });
		await bg.execute(item.execution);
		item.completion.resolve({ result: result() });
		await tick();
		expect(bg.get(item.control.id).status).toBe("completed");
		expect(bg.pendingNotifications()).toEqual([]);
		expect(bg.claimNotification(item.control.id)).toBe(false);
		first();
		first();
		expect(bg.pendingNotifications()).toEqual([]);
		second();
		expect(bg.pendingNotifications()).toHaveLength(1);
		expect(bg.claimNotification(item.control.id)).toBe(true);
		expect(bg.claimNotification(item.control.id)).toBe(false);
		expect(bg.pendingNotifications()).toEqual([]);
		bg.releaseNotification(item.control.id);
		expect(bg.pendingNotifications()).toHaveLength(1);
		bg.markDelivered(item.control.id);
		bg.releaseNotification(item.control.id);
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("active wait observes completion without persisted acknowledgement and cleans resources", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const bg = service();
		const item = job({ background: true });
		await bg.execute(item.execution);
		const parent = new AbortController();
		const waiting = bg.wait(item.control.id, 60_000, parent.signal);
		const candidates: number[] = [];
		bg.subscribe(() => {
			candidates.push(bg.pendingNotifications().length);
		});
		item.completion.resolve({ result: result() });
		expect((await waiting).status).toBe("completed");
		expect(candidates).toContain(1);
		expect(bg.pendingNotifications()).toHaveLength(1);
		bg.markDelivered(item.control.id);
		expect(bg.pendingNotifications()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
	});

	it.each(["abort", "timeout"] as const)(
		"wait %s leaves execution alive and later notification pending",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const bg = service();
			const item = job({ background: true });
			await bg.execute(item.execution);
			const parent = new AbortController();
			const waiting = bg.wait(item.control.id, 100, parent.signal);
			if (mode === "abort") {
				const rejected = expect(waiting).rejects.toThrow("stop waiting");
				parent.abort(new Error("stop waiting"));
				await rejected;
			} else {
				await vi.advanceTimersByTimeAsync(100);
				expect((await waiting).status).toBe("running");
			}
			expect(item.control.signal.aborted).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
			item.completion.resolve({ result: result() });
			await tick();
			expect(bg.pendingNotifications()).toHaveLength(1);
		},
	);

	it("wait and read on terminal leave delivery pending until persisted acknowledgement", async () => {
		const bg = service();
		const item = job({ background: true });
		await bg.execute(item.execution);
		item.completion.resolve({ result: result() });
		await tick();
		await bg.read(item.control.id);
		expect(bg.pendingNotifications()).toHaveLength(1);
		await bg.wait(item.control.id);
		expect(bg.pendingNotifications()).toHaveLength(1);
		bg.markDelivered(item.control.id);
		expect(bg.pendingNotifications()).toEqual([]);
	});
});

describe("bounded lifecycle and snapshots", () => {
	it("reserves all eight active slots synchronously, including unaccepted preflight", async () => {
		const bg = service();
		const jobs = Array.from({ length: 8 }, () => job({ run: () => new Promise(() => {}) }));
		for (const item of jobs) void bg.execute(item.execution);
		expect(bg.list()).toHaveLength(8);
		const ninth = job();
		await expect(bg.execute(ninth.execution)).rejects.toThrow("limit reached (8)");
		expect(ninth.run).not.toHaveBeenCalled();
	});

	it("retains every pending notification with bounded admission, never silent eviction", async () => {
		const bg = service();
		for (let i = 0; i < 40; i++) await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
		expect(bg.list()).toHaveLength(32);
		for (let i = 0; i < 40; i++) {
			const item = job({ background: true });
			await bg.execute(item.execution);
			item.completion.resolve({ result: result() });
			await tick();
		}
		expect(bg.list()).toHaveLength(72);
		const pending = bg.pendingNotifications();
		expect(pending).toHaveLength(40);
		const rejected = job();
		await expect(bg.execute(rejected.execution)).rejects.toThrow("retention limit");
		expect(rejected.run).not.toHaveBeenCalled();
		for (const task of pending) {
			expect(bg.claimNotification(task.id)).toBe(true);
			bg.releaseNotification(task.id);
		}
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual(pending.map((task) => task.id));
		for (const task of pending) bg.markDelivered(task.id);
		expect(bg.list()).toHaveLength(32);
		await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
	});

	it("pins selected results, releases idempotently and caps pathological pin retention", async () => {
		const bg = service({ maxHistory: 1, maxActive: 1 });
		const first = job();
		const call = bg.execute(first.execution);
		const unpin = bg.pin(first.control.id);
		first.completion.resolve({ result: result() });
		await call;
		for (let i = 0; i < 3; i++) await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
		expect(bg.get(first.control.id).status).toBe("completed");
		expect(bg.list()).toHaveLength(2);
		unpin();
		unpin();
		expect(bg.list()).toHaveLength(1);
		expect(() => bg.get(first.control.id)).toThrow("Unknown");
	});

	it("resolves unique suffix prefixes and returns isolated serializable snapshots", async () => {
		const bg = service();
		const first = job();
		const second = job();
		const calls = [bg.execute(first.execution), bg.execute(second.execution)];
		expect(bg.get(first.control.id.slice(5, 17)).id).toBe(first.control.id);
		expect(() => bg.get("bash-")).toThrow("Ambiguous");
		const snapshot = bg.get(first.control.id);
		snapshot.title = "mutated";
		expect(bg.get(first.control.id).title).toBe("test");
		first.completion.resolve({ result: result() });
		second.completion.resolve({ result: result() });
		await Promise.all(calls);
	});

	it("bounds metadata, projections, stored content and intact-or-omitted details", async () => {
		const bg = service();
		const huge = "😀".repeat(100_000);
		const item = job({ title: huge, command: huge, cwd: huge, toolCallId: huge });
		const call = bg.execute(item.execution);
		item.control.publish(result(huge), {
			text: huge,
			workers: Array.from({ length: 99 }, () => ({
				id: huge,
				label: huge,
				status: huge,
				prompt: huge,
				activity: huge,
				outcome: huge,
			})),
		});
		const snapshot = bg.get(item.control.id);
		expect(Buffer.byteLength(snapshot.title)).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(snapshot.command!)).toBeLessThanOrEqual(8192);
		expect(snapshot.projection?.workers).toHaveLength(8);
		expect(Buffer.byteLength(JSON.stringify(snapshot.projection))).toBeLessThan(120 * 1024);
		expect(Buffer.byteLength((await bg.read(item.control.id, { bytes: Infinity })).text)).toBeLessThanOrEqual(8192);
		const details = { large: huge };
		const stored = boundedResult({ content: [{ type: "text", text: huge }], details });
		expect(stored.details).toBeUndefined();
		expect(Buffer.byteLength(stored.content[0]!.type === "text" ? stored.content[0]!.text : "")).toBeLessThanOrEqual(
			BACKGROUND_RESULT_BYTES,
		);
		const intact = { nested: ["a".repeat(BACKGROUND_DETAILS_BYTES - 100)] };
		expect(boundedResult({ content: [], details: intact }).details).toEqual(intact);
		item.completion.resolve({ result: result() });
		await call;
	});

	it("closes synchronously, wakes waiters and bounds shutdown for an uncooperative executor", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const bg = service();
		const item = job({ background: true });
		await bg.execute(item.execution);
		const waiter = bg.wait(item.control.id, 60_000);
		const listener = vi.fn();
		bg.subscribe(listener);
		const shutdown = bg.shutdown(25);
		expect(bg.enabled).toBe(false);
		expect(item.control.signal.aborted).toBe(true);
		expect((await waiter).status).toBe("stopping");
		expect(bg.pendingNotifications()).toEqual([]);
		await vi.advanceTimersByTimeAsync(25);
		await shutdown;
		expect(vi.getTimerCount()).toBe(0);
		item.completion.resolve({ result: result() });
		await tick();
		expect(listener).not.toHaveBeenCalled();
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("cancels and suppresses only records outside the ancestor path, including old terminal results", async () => {
		let anchor: string | null = "keep";
		const bg = service({ anchor: () => anchor });
		const kept = job({ background: true });
		await bg.execute(kept.execution);
		anchor = null;
		const unanchored = job({ background: true });
		await bg.execute(unanchored.execution);
		anchor = "leave";
		const left = job({ background: true });
		await bg.execute(left.execution);
		const completed = job({ background: true });
		await bg.execute(completed.execution);
		completed.completion.resolve({ result: result() });
		await tick();
		left.control.signal.addEventListener("abort", () => left.completion.resolve({ result: result("cancelled") }));
		await bg.cancelOutsideBranch(new Set(["root", "keep", "new-leaf"]));
		expect(left.control.signal.aborted).toBe(true);
		expect(kept.control.signal.aborted).toBe(false);
		expect(unanchored.control.signal.aborted).toBe(false);
		expect(bg.pendingNotifications()).toEqual([]);
		kept.completion.resolve({ result: result() });
		unanchored.completion.resolve({ result: result() });
		await tick();
		expect(bg.pendingNotifications()).toHaveLength(2);
	});
});

describe("handoff and cleanup races", () => {
	it("completion wins if settled first; detach wins if handed off first, with one accounting event", async () => {
		const accounting = vi.fn();
		const bg = service({ onSettled: accounting });
		const first = job();
		const foreground = bg.execute(first.execution);
		first.completion.resolve({ result: result() });
		await tick();
		expect(bg.detachForeground()).toBe(0);
		expect((await foreground).kind).toBe("result");
		const second = job();
		const detached = bg.execute(second.execution);
		expect(bg.detachForeground()).toBe(1);
		second.completion.resolve({ result: result() });
		expect((await detached).kind).toBe("background");
		await tick();
		expect(accounting).toHaveBeenCalledTimes(2);
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual([second.control.id]);
	});

	it("does not hand off cancelled or closed preflight even if accepted afterward", async () => {
		const bg = service();
		const parent = new AbortController();
		const gate = deferred<BackgroundCompletion<{ ok: boolean }>>();
		let control!: BackgroundControl<{ ok: boolean }>;
		const call = bg.execute(
			job({
				background: true,
				signal: parent.signal,
				run: (next) => {
					control = next;
					return gate.promise;
				},
			}).execution,
		);
		const rejected = expect(call).rejects.toThrow("cancelled preflight");
		parent.abort();
		bg.close();
		control.accept();
		gate.reject(new Error("cancelled preflight"));
		await rejected;
		expect(control.signal.aborted).toBe(true);
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("checks background accounting before exposing candidates even during callback reentry", async () => {
		let bg!: BackgroundService;
		const settled = vi.fn(() => {
			expect(bg.pendingNotifications()).toEqual([]);
		});
		bg = service({ onSettled: settled });
		const item = job({ background: true });
		await bg.execute(item.execution);
		item.completion.resolve({ result: result() });
		await tick();
		expect(settled).toHaveBeenCalledOnce();
		expect(bg.pendingNotifications()).toHaveLength(1);
	});

	it("pre-aborted wait installs no listener and does not consume pending delivery", async () => {
		const bg = service();
		const item = job({ background: true });
		await bg.execute(item.execution);
		item.completion.resolve({ result: result() });
		await tick();
		const abort = new AbortController();
		abort.abort(new Error("wait cancelled"));
		await expect(bg.wait(item.control.id, 100, abort.signal)).rejects.toThrow("wait cancelled");
		expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		expect(bg.pendingNotifications()).toHaveLength(1);
	});

	it("bounds claimed history instead of letting stalled delivery grow records indefinitely", async () => {
		const bg = service({ maxActive: 1, maxHistory: 1 });
		for (let i = 0; i < 3; i++) {
			const item = job({ background: true });
			await bg.execute(item.execution);
			item.completion.resolve({ result: result() });
			await tick();
			expect(bg.claimNotification(item.control.id)).toBe(true);
		}
		await expect(bg.execute(job().execution)).rejects.toThrow("retention limit");
		expect(bg.list()).toHaveLength(3);
		for (const task of bg.list()) bg.markDelivered(task.id);
		expect(bg.list()).toHaveLength(1);
		await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
	});
});

describe("owned output leases", () => {
	it("defers eviction cleanup until an in-flight read and panel pin release", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-output-lease-"));
		const path = join(dir, "owned.log");
		try {
			await writeFile(path, "final text");
			const bg = service({ maxHistory: 0 });
			const item = job();
			const call = bg.execute(item.execution);
			const cleanup = vi.fn(() => unlink(path));
			item.control.setOutputPath(path, cleanup);
			const release = bg.pin(item.control.id);
			const reading = bg.read(item.control.id);
			item.completion.resolve({ result: result("final text") });
			await call;
			release();
			release();
			expect(cleanup).not.toHaveBeenCalled();
			expect((await reading).text).toBe("final text");
			await bg.shutdown();
			expect(cleanup).toHaveBeenCalledOnce();
			await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("cleans after close and late finish, retaining persisted final text and respecting pins", async () => {
		const snapshots: string[] = [];
		const bg = service({ onSettled: (task) => snapshots.push(JSON.stringify(task.result)) });
		const item = job({ background: true });
		await bg.execute(item.execution);
		const cleanup = vi.fn();
		item.control.setOutputPath("owned", cleanup);
		const release = bg.pin(item.control.id);
		await bg.shutdown(0);
		expect(cleanup).not.toHaveBeenCalled();
		item.completion.resolve({ result: result("saved final text") });
		await tick();
		expect(cleanup).not.toHaveBeenCalled();
		release();
		await bg.shutdown();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(snapshots[0]).toContain("saved final text");
		expect((await bg.read(item.control.id)).text).toBe("saved final text");
	});

	it("accepts cleanup registration from preflight finishing after shutdown grace", async () => {
		const bg = service();
		let control!: BackgroundControl<{ ok: boolean }>;
		const gate = deferred<BackgroundCompletion<{ ok: boolean }>>();
		const call = bg.execute(
			job({
				run: (next) => {
					control = next;
					return gate.promise;
				},
			}).execution,
		);
		await bg.shutdown(0);
		const cleanup = vi.fn();
		control.setOutputPath("late-owned-file", cleanup);
		expect(cleanup).not.toHaveBeenCalled();
		gate.resolve({ result: result("late final") });
		await call;
		await bg.shutdown();
		expect(cleanup).toHaveBeenCalledOnce();
		expect((await bg.read(control.id)).text).toBe("late final");
	});

	it("bounds cleanup failures and stalls with admission, without retries or unhandled rejection", async () => {
		const warning = vi.fn((_message: string) => {
			throw new Error("observer failed");
		});
		const bg = service({ maxHistory: 0, maxActive: 1, onCleanupError: warning });
		const item = job();
		const call = bg.execute(item.execution);
		const cleanup = vi.fn(async () => {
			throw new Error("x".repeat(10000));
		});
		item.control.setOutputPath("owned", cleanup);
		item.completion.resolve({ result: result() });
		await call;
		await bg.shutdown();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(warning.mock.calls[0]![0].length).toBeLessThanOrEqual(4096);
		const stalled = service({ maxHistory: 0, maxActive: 1 });
		for (let i = 0; i < 3; i++) {
			await stalled.execute(
				job({
					run: async (control) => {
						control.setOutputPath("owned", () => new Promise(() => {}));
						return { result: result() };
					},
				}).execution,
			);
		}
		await expect(stalled.execute(job().execution)).rejects.toThrow("retention limit");
	});

	it("parent cancellation during detached preflight prevents acceptance and restart", async () => {
		const bg = service();
		const parent = new AbortController();
		const gate = deferred<BackgroundCompletion<{ ok: boolean }>>();
		let control!: BackgroundControl<{ ok: boolean }>;
		const call = bg.execute(
			job({
				signal: parent.signal,
				run: (next) => {
					control = next;
					return gate.promise;
				},
			}).execution,
		);
		bg.detachForeground();
		parent.abort();
		control.accept();
		expect(control.signal.aborted).toBe(true);
		expect(bg.detachForeground()).toBe(0);
		gate.resolve({ result: result() });
		expect((await call).kind).toBe("result");
		expect(bg.get(control.id).status).toBe("cancelled");
	});

	it("stops notifying the copied observer batch when an observer closes the service", async () => {
		const bg = service();
		bg.subscribe(() => bg.close());
		const late = vi.fn();
		bg.subscribe(late);
		bg.setEnabled(true);
		expect(late).not.toHaveBeenCalled();
	});
});

describe("bounded UTF-8 output", () => {
	it("never splits a UTF-8 codepoint at either end of head, tail or delta slices", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-background-service-"));
		const path = join(dir, "output.log");
		try {
			await writeFile(path, "a😀中z");
			expect((await readOutputSlice(path, { mode: "head", bytes: 4 })).text).toBe("a");
			expect((await readOutputSlice(path, { mode: "tail", bytes: 5 })).text).toBe("中z");
			expect((await readOutputSlice(path, { sinceBytes: 2, bytes: 20 })).text).toBe("中z");
			expect((await readOutputSlice(path, { sinceBytes: 999, bytes: 20 })).text).toBe("a😀中z");
			for (let bytes = 0; bytes < 12; bytes++) {
				expect(boundText("😀中😀", bytes)).not.toContain("�");
				expect(Buffer.byteLength(boundText("😀中😀", bytes))).toBeLessThanOrEqual(bytes);
			}
			await writeFile(path, Buffer.from([0x61, 0xf0, 0x9f]));
			expect((await readOutputSlice(path)).text).toBe("a");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a bounded file slice, reports failures, and never unlinks executor-owned files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-background-service-"));
		const path = join(dir, "legacy-foreground.log");
		try {
			await writeFile(path, "x".repeat(200_000));
			const bg = service({ maxHistory: 0 });
			const item = job();
			const call = bg.execute(item.execution);
			item.control.setOutputPath(path);
			const output = await bg.read(item.control.id, { bytes: 1_000_000 });
			expect(output.totalBytes).toBe(200_000);
			expect(output.truncated).toBe(true);
			expect(Buffer.byteLength(output.text)).toBe(BACKGROUND_RESULT_BYTES);
			item.control.setOutputPath(join(dir, "missing"));
			expect((await bg.read(item.control.id)).readError).toContain("Output could not be read");
			item.control.setOutputPath(path);
			item.completion.resolve({ result: result() });
			await call;
			await bg.shutdown();
			expect((await readFile(path)).length).toBe(200_000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("terminal diagnostics and partial usage", () => {
	it("keeps terminal and read diagnostics independent of raw log and fallback tail slices", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-background-diagnostics-"));
		const path = join(dir, "output.log");
		try {
			await writeFile(path, "raw log ending");
			const bg = service();
			const item = job({ background: true });
			await bg.execute(item.execution);
			item.control.setOutputPath(path, () => rm(path, { force: true }));
			item.completion.resolve({
				result: result(`stored report ${"x".repeat(20000)}`),
				status: "failed",
				error: `output limit exceeded ${"😀".repeat(5000)}`,
			});
			await tick();
			const output = await bg.read(item.control.id, { bytes: 6 });
			expect(output.text).toBe("ending");
			expect(output.readError).toBeUndefined();
			expect(output.task.error).toContain("output limit exceeded");
			expect(Buffer.byteLength(output.task.error!)).toBeLessThanOrEqual(4096);
			await unlink(path);
			const missing = await bg.read(item.control.id, { bytes: 6, sinceBytes: 999999 });
			expect(missing.text).toBe("xxxxxx");
			expect(missing.readError).toContain("Output could not be read");
			expect(missing.task.error).toBe(output.task.error);
			await bg.shutdown();
			const expired = await bg.read(item.control.id, { bytes: 0 });
			expect(expired.text).toBe("");
			expect(expired.readError).toContain("expired");
			expect(expired.task.error).toBe(output.task.error);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each(["reject", "completion", "result"] as const)(
		"settles cumulative published usage once with %s precedence",
		async (finish) => {
			const usage = (input: number): Usage => ({
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
			});
			const onSettled = vi.fn();
			const bg = service({ onSettled });
			const item = job({ background: true });
			await bg.execute(item.execution);
			item.control.publish({ ...result(), usage: usage(2) });
			const last = usage(5);
			item.control.publish({ ...result(), usage: last });
			last.input = 999;
			item.control.publish(result("no usage does not clear snapshot"));
			if (finish === "reject") item.completion.reject(new Error("failed after work"));
			else
				item.completion.resolve({
					result: { ...result(), usage: usage(7) },
					usage: finish === "completion" ? usage(9) : undefined,
				});
			await tick();
			await bg.read(item.control.id);
			await bg.wait(item.control.id);
			item.control.publish({ ...result(), usage: usage(99) });
			expect(onSettled).toHaveBeenCalledOnce();
			expect(onSettled.mock.calls[0]![1]).toEqual(usage(finish === "reject" ? 5 : finish === "completion" ? 9 : 7));
			expect(bg.get(item.control.id).result?.usage).toBeUndefined();
		},
	);

	it("never guesses rejected usage from result details", async () => {
		const onSettled = vi.fn();
		const bg = service({ onSettled });
		const item = job({ background: true });
		await bg.execute(item.execution);
		const details = { ok: true, usage: { input: 999 } };
		item.control.publish({ content: [], details });
		item.completion.reject(new Error("failed"));
		await tick();
		expect(onSettled).toHaveBeenCalledOnce();
		expect(onSettled.mock.calls[0]![1]).toBeUndefined();
	});
});

function savedTask(id = "bash-restored", endedAt = 20, overrides: Partial<BackgroundTask> = {}) {
	return {
		version: 1,
		task: {
			id,
			kind: "bash",
			title: "saved",
			toolCallId: "call",
			anchorId: null,
			mode: "background",
			status: "completed",
			startedAt: 10,
			endedAt,
			result: result("saved report"),
			...overrides,
		} satisfies BackgroundTask,
	};
}

describe("terminal history restoration", () => {
	it("hides branch A history and ignored-abort work on B, then reveals A without restarting or renotifying", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let anchor: string | null = "A";
		const onSettled = vi.fn();
		const bg = service({ anchor: () => anchor, onSettled, maxActive: 2 });
		bg.restoreHistory([savedTask("bash-history-A", 20, { anchorId: "A" })]);
		const ignored = job({ background: true });
		await bg.execute(ignored.execution);
		const terminal = job({ background: true });
		await bg.execute(terminal.execution);
		terminal.completion.resolve({ result: result() });
		await tick();
		anchor = null;
		const rooted = job({ background: true });
		await bg.execute(rooted.execution);
		const leaving = bg.cancelOutsideBranch(new Set(["B"]));
		expect(bg.list().map((task) => task.id)).toEqual([rooted.control.id]);
		expect(bg.get(ignored.control.id).status).toBe("stopping");
		await expect(bg.execute(job().execution)).rejects.toThrow("limit reached (2)");
		expect(bg.pendingNotifications()).toEqual([]);
		expect(rooted.control.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(2000);
		await leaving;
		bg.restoreHistory([savedTask("bash-history-B", 30, { anchorId: "B" })]);
		ignored.completion.resolve({ result: result("late") });
		await tick();
		await bg.cancelOutsideBranch(new Set(["A"]));
		bg.restoreHistory([
			savedTask("bash-history-A", 20, { anchorId: "A" }),
			{ version: 1, task: bg.get(terminal.control.id) },
		]);
		expect(bg.list().map((task) => task.id)).toEqual([
			"bash-history-A",
			ignored.control.id,
			terminal.control.id,
			rooted.control.id,
		]);
		expect(bg.get(ignored.control.id).status).toBe("cancelled");
		expect(bg.pendingNotifications()).toEqual([]);
		expect(ignored.run).toHaveBeenCalledOnce();
		expect(onSettled).toHaveBeenCalledTimes(2);
		rooted.completion.resolve({ result: result() });
		await tick();
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual([rooted.control.id]);
	});

	it("reveals matching hidden terminal IDs even at full history capacity without restoring delivery", async () => {
		const bg = service({ maxHistory: 1 });
		const saved = savedTask("bash-history-A", 20, { anchorId: "A" });
		bg.restoreHistory([saved]);
		await bg.cancelOutsideBranch(new Set(["B"]));
		expect(bg.list()).toEqual([]);
		bg.restoreHistory([saved]);
		expect(bg.list().map((task) => task.id)).toEqual([saved.task.id]);
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("restores newest terminal IDs without observers, accounting, notifications or deletion ownership", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-background-restore-"));
		const path = join(dir, "saved.log");
		try {
			await writeFile(path, "saved raw log");
			const onSettled = vi.fn();
			const onCleanupError = vi.fn();
			const observer = vi.fn();
			const bg = service({ maxHistory: 2, maxActive: 1, onSettled, onCleanupError });
			bg.subscribe(observer);
			bg.restoreHistory([
				savedTask("bash-new", 50, { outputPath: path, status: "cancelled" }),
				savedTask("bash-old", 15),
				savedTask("bash-duplicate", 40, { title: "new duplicate" }),
				savedTask("bash-duplicate", 20, { title: "old duplicate" }),
				savedTask("bash-live", 100, { status: "running" }),
			]);
			expect(bg.list().map((task) => task.id)).toEqual(["bash-duplicate", "bash-new"]);
			expect(bg.get("bash-duplicate").title).toBe("new duplicate");
			expect(bg.kill("bash-new")).toBe(false);
			expect(bg.detachForeground()).toBe(0);
			expect(bg.pendingNotifications()).toEqual([]);
			expect(bg.claimNotification("bash-new")).toBe(false);
			expect((await bg.read("bash-new")).text).toBe("saved raw log");
			expect((await bg.wait("bash-new")).status).toBe("cancelled");
			expect(onSettled).not.toHaveBeenCalled();
			expect(observer).not.toHaveBeenCalled();
			await bg.execute(job({ run: async () => ({ result: result() }) }).execution);
			expect(bg.list()).toHaveLength(2);
			expect(() => bg.get("bash-duplicate")).toThrow("Unknown");
			await bg.shutdown();
			expect(await readFile(path, "utf8")).toBe("saved raw log");
			expect(onCleanupError).not.toHaveBeenCalled();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("ignores malformed, nonterminal and malicious records without invoking callbacks", () => {
		const bg = service();
		const getter = vi.fn(() => "completed");
		const malformed: unknown[] = [null, 7, [], {}, { version: 2, task: savedTask().task }];
		for (const [key, value] of [
			["kind", "worker"],
			["mode", "detached"],
			["status", "running"],
			["status", "queued"],
			["status", "stopping"],
			["status", "fake"],
			["id", "worker-1"],
			["id", "bash-"],
			["id", "x".repeat(10000)],
			["toolCallId", 3],
			["anchorId", {}],
			["anchorId", "x".repeat(10000)],
			["startedAt", NaN],
			["startedAt", -1],
			["endedAt", Infinity],
			["endedAt", 9],
			["endedAt", undefined],
			["title", {}],
			["error", []],
			["outputPath", "x".repeat(10000)],
			["projection", { workers: [null] }],
			["result", { content: [null] }],
		] as const)
			malformed.push({ version: 1, task: { ...savedTask().task, [key]: value } });
		malformed.push({ version: 1, task: Object.defineProperty(savedTask().task, "status", { get: getter }) });
		bg.restoreHistory(malformed);
		expect(bg.list()).toEqual([]);
		expect(getter).not.toHaveBeenCalled();
	});

	it("bounds huge snapshots, strips runtime data and isolates restored projections", async () => {
		const bg = service();
		const huge = "😀".repeat(100000);
		const serialize = vi.fn();
		const worker = {
			id: huge,
			label: huge,
			status: huge,
			prompt: huge,
			activity: huge,
			outcome: huge,
			model: huge,
			usage: huge,
		};
		const record = savedTask("subagent-group", 20, {
			kind: "subagent",
			title: huge,
			command: huge,
			cwd: huge,
			error: huge,
			projection: { text: huge, workers: Array(100).fill(worker) },
			result: { content: [{ type: "text", text: huge }], details: { toJSON: serialize } },
		});
		bg.restoreHistory([record]);
		const task = bg.get("subagent-group");
		expect(Buffer.byteLength(task.title)).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(task.command!)).toBeLessThanOrEqual(8192);
		expect(Buffer.byteLength(task.cwd!)).toBeLessThanOrEqual(4096);
		expect(Buffer.byteLength(task.error!)).toBeLessThanOrEqual(4096);
		expect(task.projection?.workers).toHaveLength(8);
		expect(Buffer.byteLength(JSON.stringify(task.projection))).toBeLessThan(128 * 1024);
		expect(task.result?.details).toBeUndefined();
		expect(Buffer.byteLength((await bg.read(task.id, { bytes: 999999 })).text)).toBeLessThanOrEqual(
			BACKGROUND_RESULT_BYTES,
		);
		expect(serialize).not.toHaveBeenCalled();
		worker.label = "mutated";
		expect(bg.get(task.id).projection?.workers?.[0]?.label).not.toBe("mutated");
		expect(() => bg.get(task.projection!.workers![0]!.id)).toThrow("Unknown");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		bg.restoreHistory([
			savedTask("bash-huge-details", 21, { result: { content: [], details: { huge } } }),
			savedTask("bash-cycle", 22, { result: { content: [], details: cyclic } }),
		]);
		expect(bg.get("bash-huge-details").result?.details).toBeUndefined();
		expect(bg.get("bash-cycle").result?.details).toBeUndefined();
	});

	it("reports expired restored paths even with an empty requested slice", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-expired-history-"));
		try {
			const bg = service();
			bg.restoreHistory([
				savedTask("bash-expired", 20, {
					outputPath: join(dir, "missing"),
					error: "command failed",
					status: "failed",
				}),
			]);
			const output = await bg.read("bash-expired", { bytes: 0 });
			expect(output.text).toBe("");
			expect(output.readError).toContain("Output could not be read");
			expect(output.task.error).toBe("command failed");
			expect((await bg.read("bash-expired")).text).toBe("saved report");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves existing records and ignores closed/zero-history services", async () => {
		const bg = service({ maxHistory: 1 });
		const active = job({ background: true });
		await bg.execute(active.execution);
		bg.restoreHistory([savedTask(active.control.id), savedTask("bash-history")]);
		expect(bg.get(active.control.id).status).toBe("running");
		bg.restoreHistory([savedTask("bash-history", 30, { title: "replacement" }), savedTask("bash-extra")]);
		expect(bg.get("bash-history").title).toBe("saved");
		expect(bg.list()).toHaveLength(2);
		active.completion.resolve({ result: result() });
		await tick();
		expect(bg.list()).toHaveLength(2);
		expect(bg.pendingNotifications()).toHaveLength(1);
		bg.markDelivered(active.control.id);
		expect(bg.list()).toHaveLength(1);
		bg.close();
		bg.restoreHistory([savedTask("bash-closed")]);
		expect(() => bg.get("bash-closed")).toThrow("Unknown");
		const zero = service({ maxHistory: 0 });
		zero.restoreHistory([savedTask()]);
		expect(zero.list()).toEqual([]);
	});
});
