import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { TASK_RESULT_BYTES } from "../src/core/tasks/output.ts";
import { TaskRuntime } from "../src/core/tasks/runtime.ts";
import { TaskSession } from "../src/core/tasks/session.ts";
import type { TaskCompletion, TaskControl, TaskExecution, TaskKind, TaskSnapshot } from "../src/core/tasks/types.ts";

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
const services: TaskRuntime[] = [];
function service(options: ConstructorParameters<typeof TaskRuntime>[0] = {}) {
	const instance = new TaskRuntime({ enabled: true, ...options });
	services.push(instance);
	return instance;
}
const hosts: TaskSession[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.dispose();
	for (const instance of services.splice(0)) instance.close();
	vi.useRealTimers();
});

function savedTask(id = "bash-restored", endedAt = 20, overrides: Partial<TaskSnapshot> = {}) {
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
		} satisfies TaskSnapshot,
	};
}

describe("terminal history restoration", () => {
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
		await expect(bg.execute(job({ background: true }).execution)).rejects.toThrow(
			"Background task limit reached (2)",
		);
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

	it("restores newest terminal IDs without observers, accounting, notifications, logs or deletion ownership", async () => {
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
			expect(await bg.read("bash-new")).toMatchObject({
				text: "saved report",
				readError: expect.stringContaining("expired"),
			});
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
	it("ignores malformed and nonterminal records", () => {
		const bg = service();
		const malformed: unknown[] = [null, {}, { version: 3, task: savedTask().task }];
		for (const [key, value] of [
			["status", "running"],
			["id", "bash-"],
			["startedAt", Number.NaN],
			["result", { content: [null] }],
		] as const)
			malformed.push({ version: 2, task: { ...savedTask().task, [key]: value } });
		bg.restoreHistory(malformed);
		expect(bg.list()).toEqual([]);
	});

	it("bounds huge snapshots and strips runtime data", async () => {
		const bg = service();
		const huge = "😀".repeat(100000);
		const record = savedTask("custom-group", 20, {
			kind: "custom",
			title: huge,
			command: huge,
			cwd: huge,
			error: huge,
			result: { content: [{ type: "text", text: huge }], details: { huge } },
		});
		bg.restoreHistory([record]);
		const task = bg.get("custom-group");
		expect(Buffer.byteLength(task.title)).toBeLessThanOrEqual(1024);
		expect(Buffer.byteLength(task.command!)).toBeLessThanOrEqual(8192);
		expect(Buffer.byteLength(task.cwd!)).toBeLessThanOrEqual(4096);
		expect(Buffer.byteLength(task.error!)).toBeLessThanOrEqual(4096);
		expect(task.result?.details).toBeUndefined();
		expect(Buffer.byteLength((await bg.read(task.id, { bytes: 999999 })).text)).toBeLessThanOrEqual(
			TASK_RESULT_BYTES,
		);
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
			expect(output.readError).toContain("Output has expired");
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

	it("round-trips the process exit code through restored history", () => {
		const bg = service();
		bg.restoreHistory([savedTask("bash-exit", 20, { exitCode: 3 })]);
		expect(bg.get("bash-exit").exitCode).toBe(3);
		bg.restoreHistory([savedTask("bash-reaped", 30, { exitCode: null })]);
		expect(bg.get("bash-reaped").exitCode).toBeNull();
		bg.restoreHistory([savedTask("bash-unreported", 40)]);
		expect(bg.get("bash-unreported").exitCode).toBeUndefined();
		// Malformed values drop the record rather than corrupting the listing.
		bg.restoreHistory([savedTask("bash-bad", 50, { exitCode: "3" as unknown as number })]);
		expect(bg.list().find((task) => task.id === "bash-bad")).toBeUndefined();
	});
});

const textResult = (text: string): AgentToolResult<undefined> => ({
	content: [{ type: "text", text }],
	details: undefined,
});
function retention(maxHistory = 32) {
	return service({ maxHistory, maxActive: 1 });
}
function launch(bg: TaskRuntime, kind: TaskKind, background = false, text = "saved report") {
	let control!: TaskControl<undefined>;
	let finish!: () => void;
	const completion = new Promise<TaskCompletion<undefined>>((resolve) => {
		finish = () => resolve({ result: textResult(text) });
	});
	const caller = bg.execute({
		kind,
		title: kind,
		toolCallId: "call",
		background,
		run(next) {
			control = next;
			next.accept();
			return completion;
		},
	});
	return { control, caller, finish };
}
async function complete(bg: TaskRuntime, kind: TaskKind, background = false, text?: string) {
	const run = launch(bg, kind, background, text);
	if (background) expect((await run.caller).kind).toBe("background");
	run.finish();
	await bg.wait(run.control.id);
	await run.caller;
	bg.markDelivered(run.control.id);
	return run.control.id;
}
function saved(id: string, endedAt: number, overrides: Partial<TaskSnapshot> = {}) {
	return {
		version: 2,
		task: {
			id,
			kind: "bash",
			mode: "foreground",
			title: id,
			toolCallId: id,
			anchorId: null,
			status: "completed",
			startedAt: 0,
			endedAt,
			result: textResult(id),
			...overrides,
		} satisfies TaskSnapshot,
	};
}

describe("independent foreground and background histories", () => {
	it.each([
		{ kind: "bash" as const, background: true },
		{ kind: "custom", background: true },
	])("keeps completed $kind, background=$background after 100 foreground shells", async ({ kind, background }) => {
		const bg = retention();
		const id = await complete(bg, kind, background);
		for (let i = 0; i < 100; i++) await complete(bg, "bash");
		expect(bg.list()).toHaveLength(33);
		expect(bg.get(id)).toMatchObject({ status: "completed", mode: background ? "background" : "foreground" });
		expect((await bg.read(id)).text).toBe("saved report");
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("evicts only the oldest delivered record in the history that exceeds its allowance", async () => {
		const bg = retention(2);
		const firstShell = await complete(bg, "bash");
		const secondShell = await complete(bg, "bash");
		const firstTask = await complete(bg, "custom", true);
		const secondTask = await complete(bg, "bash", true);
		const thirdTask = await complete(bg, "custom", true);
		expect(() => bg.get(firstTask)).toThrow("Unknown");
		expect(bg.get(firstShell).status).toBe("completed");
		const thirdShell = await complete(bg, "custom");
		expect(() => bg.get(firstShell)).toThrow("Unknown");
		expect(bg.list().map((task) => task.id)).toEqual([secondShell, secondTask, thirdTask, thirdShell]);
	});

	it("retains a detached shell with background history and protects its managed log", async () => {
		const bg = retention(1);
		const run = launch(bg, "bash");
		let cleaned = false;
		run.control.setOutputPath("diagnostic-log", () => {
			cleaned = true;
		});
		expect(bg.detachForeground()).toBe(1);
		expect((await run.caller).kind).toBe("background");
		run.finish();
		await bg.wait(run.control.id);
		bg.markDelivered(run.control.id);
		for (let i = 0; i < 100; i++) await complete(bg, "bash");
		expect(bg.get(run.control.id).mode).toBe("background");
		expect(cleaned).toBe(false);
		await complete(bg, "custom", true);
		expect(() => bg.get(run.control.id)).toThrow("Unknown");
		await bg.shutdown();
		expect(cleaned).toBe(true);
	});

	it.each([false, true])("restores both histories independently, reverse input=%s", async (reverse) => {
		const bg = retention();
		const records = [
			saved("custom-background", 1, { kind: "custom", mode: "background" }),
			saved("custom-foreground", 2, { kind: "custom" }),
			...Array.from({ length: 100 }, (_, index) => saved(`bash-${index}`, index + 3)),
		];
		bg.restoreHistory(reverse ? records.reverse() : records);
		expect(bg.list()).toHaveLength(33);
		expect((await bg.read("custom-background")).text).toBe("custom-background");
		// Foreground work of any kind shares the foreground history.
		expect(() => bg.get("custom-foreground")).toThrow("Unknown");
		expect(() => bg.get("bash-67")).toThrow("Unknown");
		expect(bg.get("bash-68").status).toBe("completed");
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("restores task history when runtime foreground shell history is already full", async () => {
		const bg = retention(1);
		const id = await complete(bg, "bash");
		bg.restoreHistory([saved("bash-extra", 3), saved("custom-restored", 1, { kind: "custom", mode: "background" })]);
		expect(bg.list().map((task) => task.id)).toEqual([id, "custom-restored"]);
		expect((await bg.read(id)).text).toBe("saved report");
	});

	it("prefers background results when protected records leave only one restoration slot", () => {
		const bg = retention(1);
		const releases: Array<() => void> = [];
		for (let i = 0; i < 3; i++) {
			const record = saved(`bash-pinned-${i}`, i);
			bg.restoreHistory([record]);
			releases.push(bg.retain(record.task.id));
		}
		bg.restoreHistory([
			saved("bash-newer-shell", 100),
			saved("custom-older-task", 1, { kind: "custom", mode: "background" }),
		]);
		expect(bg.list()).toHaveLength(4);
		expect(bg.get("custom-older-task").status).toBe("completed");
		expect(() => bg.get("bash-newer-shell")).toThrow("Unknown");
		for (const release of releases) release();
		expect(bg.list()).toHaveLength(2);
	});

	it("releases and restores both histories when returning to a branch", async () => {
		const bg = retention(1);
		const branchA = [
			saved("custom-A", 1, { kind: "custom", mode: "background", anchorId: "A" }),
			saved("bash-A", 2, { anchorId: "A" }),
		];
		const branchB = [
			saved("bash-background-B", 3, { mode: "background", anchorId: "B" }),
			saved("bash-foreground-B", 4, { anchorId: "B" }),
		];
		bg.restoreHistory(branchA);
		await bg.cancelOutsideBranch(new Set(["B"]));
		expect(bg.list()).toEqual([]);
		bg.restoreHistory(branchB);
		expect(bg.list().map((task) => task.id)).toEqual(branchB.map((record) => record.task.id));
		await bg.cancelOutsideBranch(new Set(["A"]));
		bg.restoreHistory(branchA);
		expect(bg.list().map((task) => task.id)).toEqual(branchA.map((record) => record.task.id));
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("restores background results from the session journal after runtime replacement", async () => {
		const manager = SessionManager.inMemory();
		const host = new TaskSession({
			manager,
			canDeliver: () => false,
			deliver: async () => {},
			onEntry: () => {},
			onError: (_event, message) => {
				throw new Error(message);
			},
		});
		hosts.push(host);
		host.setEnabled(true);
		const background = await complete(host.service, "custom", true);
		for (let i = 0; i < 100; i++) await complete(host.service, "bash");
		const entries = manager.getEntries().length;
		await host.service.shutdown();
		host.replaceService();
		expect(host.service.list()).toHaveLength(33);
		expect((await host.service.read(background)).text).toBe("saved report");
		expect(host.service.pendingNotifications()).toEqual([]);
		expect(manager.getEntries()).toHaveLength(entries);
	});
});
