import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_BYTES } from "../src/core/background/output.ts";
import { BackgroundService } from "../src/core/background/service.ts";
import type {
	BackgroundCompletion,
	BackgroundControl,
	BackgroundExecution,
	BackgroundTask,
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

function savedTask(id = "bash-restored", endedAt = 20, overrides: Partial<BackgroundTask> = {}) {
	return {
		version: 2,
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
	it("restores another branch when the previous branch filled terminal history", async () => {
		const bg = service({ maxHistory: 1 });
		const branchA = savedTask("bash-history-A", 20, { anchorId: "A" });
		const branchB = savedTask("bash-history-B", 30, { anchorId: "B" });
		bg.restoreHistory([branchA]);
		await bg.cancelOutsideBranch(new Set(["B"]));
		bg.restoreHistory([branchB]);
		expect(bg.list().map((task) => task.id)).toEqual([branchB.task.id]);
		await bg.cancelOutsideBranch(new Set(["A"]));
		bg.restoreHistory([branchA]);
		expect(bg.list().map((task) => task.id)).toEqual([branchA.task.id]);
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("hides branch A history and ignored-abort work on B, then reveals A and revives undelivered completions", async () => {
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
			{ version: 2, task: bg.get(terminal.control.id) },
		]);
		expect(
			bg
				.list()
				.map((task) => task.id)
				.sort(),
		).toEqual(["bash-history-A", ignored.control.id, terminal.control.id, rooted.control.id].sort());
		expect(bg.get(ignored.control.id).status).toBe("cancelled");
		// Restored history never renotifies; undelivered runtime completions revive on return.
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual([ignored.control.id, terminal.control.id]);
		expect(ignored.run).toHaveBeenCalledOnce();
		expect(onSettled).toHaveBeenCalledTimes(2);
		rooted.completion.resolve({ result: result() });
		await tick();
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual([
			ignored.control.id,
			terminal.control.id,
			rooted.control.id,
		]);
	});

	it("restores a branch's delivered history after eviction without restoring delivery", async () => {
		const bg = service({ maxHistory: 1 });
		const saved = savedTask("bash-history-A", 20, { anchorId: "A" });
		bg.restoreHistory([saved]);
		await bg.cancelOutsideBranch(new Set(["B"]));
		expect(bg.list()).toEqual([]);
		bg.restoreHistory([saved]);
		expect(bg.list().map((task) => task.id)).toEqual([saved.task.id]);
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("restores history alongside pending completions without spending their retention allowance", async () => {
		const bg = service({ maxHistory: 1, maxActive: 1 });
		const pending = job({ background: true });
		await bg.execute(pending.execution);
		pending.completion.resolve({ result: result() });
		await tick();
		bg.restoreHistory([savedTask("bash-history")]);
		expect(bg.list()).toHaveLength(2);
		expect(bg.get("bash-history").status).toBe("completed");
		expect(bg.pendingNotifications().map((task) => task.id)).toEqual([pending.control.id]);
	});

	it("bounds restoration even when every retained record is pinned", () => {
		const bg = service({ maxHistory: 1, maxActive: 1 });
		const releases: Array<() => void> = [];
		for (let index = 0; index < 4; index++) {
			const id = `bash-pinned-${index}`;
			bg.restoreHistory([savedTask(id)]);
			releases.push(bg.pin(id));
		}
		bg.restoreHistory([savedTask("bash-over-budget")]);
		expect(bg.list()).toHaveLength(4);
		expect(() => bg.get("bash-over-budget")).toThrow("Unknown");
		for (const release of releases) release();
		expect(bg.list()).toHaveLength(1);
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
			expect(bg.list()).toHaveLength(3);
			expect(bg.get("bash-duplicate").title).toBe("new duplicate");
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
		const malformed: unknown[] = [null, 7, [], {}, { version: 3, task: savedTask().task }];
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
			malformed.push({ version: 2, task: { ...savedTask().task, [key]: value } });
		malformed.push({ version: 2, task: Object.defineProperty(savedTask().task, "status", { get: getter }) });
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
			profile: huge,
			description: huge,
			report: { text: huge, truncated: false },
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
