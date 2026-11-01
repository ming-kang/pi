import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskSession } from "../src/core/tasks/session.ts";
import type { TaskControl, TaskExecution } from "../src/core/tasks/types.ts";
import { createDeliveryHarness } from "./tasks-delivery-harness.ts";

const result = (text = "done"): AgentToolResult<undefined> => ({
	content: [{ type: "text", text }],
	details: undefined,
});

/** A background task that stays running until `finish()`. */
function backgroundJob(overrides: Partial<TaskExecution<undefined>> = {}) {
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let control!: TaskControl<undefined>;
	const execution: TaskExecution<undefined> = {
		kind: "bash",
		title: "work",
		toolCallId: "call",
		background: true,
		run: async (next) => {
			control = next;
			next.accept();
			await done;
			return { result: result() };
		},
		...overrides,
	};
	return {
		execution,
		finish,
		get control() {
			return control;
		},
	};
}

const harnesses: ReturnType<typeof createDeliveryHarness>[] = [];
const hosts: TaskSession[] = [];
function delivering(options: Parameters<typeof createDeliveryHarness>[0] = {}) {
	const harness = createDeliveryHarness(options);
	harnesses.push(harness);
	return harness;
}
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.dispose();
	for (const host of hosts.splice(0)) host.dispose();
});

async function settle(harness: ReturnType<typeof delivering>, item = backgroundJob()) {
	await harness.runtime.execute(item.execution);
	item.finish();
	await harness.runtime.wait(item.control.id, { timeoutMs: 1000 });
	return item.control.id;
}

describe("TaskDelivery completion queue", () => {
	it("delivers a settled handoff exactly once and then forgets it", async () => {
		const harness = delivering({ canDeliver: () => true });
		const id = await settle(harness);
		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
		expect(harness.delivered[0]).toMatchObject({ customType: "task-completion", details: { task: { id } } });
		expect(harness.pending()).toEqual([]);
		harness.delivery.schedule();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(harness.delivered).toHaveLength(1);
	});

	it("keeps a failed delivery pending, without a timer retry, until the host retries", async () => {
		let fail = true;
		const attempts: string[] = [];
		const harness = delivering({
			canDeliver: () => true,
			deliver: async (message) => {
				attempts.push(message.customType);
				if (fail) throw new Error("host down");
				harness.delivery.messageStarted(message);
				harness.delivery.messagePersisted(message);
			},
		});
		const id = await settle(harness);
		await vi.waitFor(() => expect(attempts).toHaveLength(1));
		expect(harness.warnings.at(-1)).toContain(`delivery failed for ${id}`);
		expect(harness.pending().map((task) => task.id)).toEqual([id]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(attempts).toHaveLength(1);
		fail = false;
		harness.delivery.retry();
		await vi.waitFor(() => expect(attempts).toHaveLength(2));
		await vi.waitFor(() => expect(harness.pending()).toEqual([]));
	});

	it("holds an in-flight completion's lease, so stalled deliveries bound retained records", async () => {
		const harness = delivering({
			maxBackground: 1,
			maxHistory: 1,
			canDeliver: () => true,
			// The host accepts the message but never confirms persistence.
			deliver: () => new Promise<void>(() => {}),
		});
		const ids: string[] = [];
		// Retention allows maxBackground + 3 * maxHistory records, so the fifth submission is refused.
		for (let i = 0; i < 4; i++) ids.push(await settle(harness));
		await expect(harness.runtime.execute(backgroundJob().execution)).rejects.toThrow("retention limit");
		expect(harness.runtime.list()).toHaveLength(4);
		for (const id of ids) harness.delivery.acknowledge(id);
		expect(harness.runtime.list()).toHaveLength(1);
		await harness.runtime.execute(backgroundJob().execution);
	});

	it("acknowledging a completion stops its delivery and is idempotent", async () => {
		const harness = delivering({ canDeliver: () => false });
		const id = await settle(harness);
		expect(harness.pending().map((task) => task.id)).toEqual([id]);
		harness.delivery.acknowledge(id);
		harness.delivery.acknowledge(id);
		harness.delivery.acknowledge("unknown-task");
		expect(harness.pending()).toEqual([]);
	});

	it("keeps an observed completion out of delivery until its hold is released", async () => {
		let open = true;
		const harness = delivering({ canDeliver: () => open });
		open = false;
		const id = await settle(harness);
		const release = harness.delivery.hold([id]);
		open = true;
		harness.delivery.schedule();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(harness.delivered).toEqual([]);
		expect(harness.pending()).toEqual([]);
		release();
		release();
		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
	});

	it("retains pending output while delivery waits, and runs its cleanup once the lease is released", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-delivery-lease-"));
		const path = join(dir, "output.log");
		try {
			await writeFile(path, "log text");
			const harness = delivering({ maxHistory: 0 });
			const item = backgroundJob();
			const cleanup = vi.fn(async () => rm(path, { force: true }));
			await harness.runtime.execute(item.execution);
			item.control.attachOutput(path, cleanup);
			item.finish();
			await harness.runtime.wait(item.control.id, { timeoutMs: 1000 });
			expect(cleanup).not.toHaveBeenCalled();
			expect((await harness.runtime.read(item.control.id)).text).toBe("log text");
			harness.delivery.acknowledge(item.control.id);
			await harness.runtime.shutdown();
			expect(cleanup).toHaveBeenCalledOnce();
			await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("releases the leases of a runtime that closes, so its output is cleaned without a delivery", async () => {
		const harness = delivering();
		const item = backgroundJob();
		const cleanup = vi.fn();
		await harness.runtime.execute(item.execution);
		item.control.attachOutput("owned", cleanup);
		item.finish();
		await harness.runtime.wait(item.control.id, { timeoutMs: 1000 });
		expect(harness.pending()).toHaveLength(1);
		await harness.runtime.shutdown();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(harness.pending()).toEqual([]);
	});
});

describe("TaskSession settlement and replacement", () => {
	function sessionHost(delivered: string[] = []) {
		const manager = SessionManager.inMemory(process.cwd());
		const host = new TaskSession({
			manager,
			canDeliver: () => false,
			deliver: async (message) => {
				delivered.push(String(message.content));
			},
			onEntry: () => {},
			onError: () => {},
		});
		host.setEnabled(true);
		hosts.push(host);
		return { host, manager };
	}

	it("persists a handed-off settlement and then queues it for delivery; inline results are neither queued nor background", async () => {
		const { host, manager } = sessionHost();
		const inline = await host.service.execute({
			kind: "bash",
			title: "inline",
			toolCallId: "inline",
			run: async () => ({ result: result() }),
		});
		expect(inline.kind).toBe("result");
		const item = backgroundJob();
		await host.service.execute(item.execution);
		item.finish();
		await host.service.wait(item.control.id, { timeoutMs: 1000 });
		const saved = manager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === "task-record" ? [entry.data] : []));
		expect(saved).toHaveLength(2);
		expect(host.delivery.pending().map((task) => task.id)).toEqual([item.control.id]);
	});

	it("does not deliver completions still pending when the service is replaced, and releases their output", async () => {
		const delivered: string[] = [];
		const { host } = sessionHost(delivered);
		const item = backgroundJob();
		const cleanup = vi.fn();
		await host.service.execute(item.execution);
		item.control.attachOutput("owned", cleanup);
		item.finish();
		await host.service.wait(item.control.id, { timeoutMs: 1000 });
		expect(host.delivery.pending()).toHaveLength(1);
		await host.shutdown();
		host.replaceService();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(host.delivery.pending()).toEqual([]);
		host.delivery.retry();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(delivered).toEqual([]);
	});

	it("keeps a completion launched on a hidden branch until its branch is visible again", async () => {
		const delivered: string[] = [];
		let open = false;
		const manager = SessionManager.inMemory(process.cwd());
		const host = new TaskSession({
			manager,
			canDeliver: () => open,
			deliver: async (message) => {
				delivered.push(String(message.content));
			},
			onEntry: () => {},
			onError: () => {},
		});
		host.setEnabled(true);
		hosts.push(host);
		const branchA = manager.appendMessage({ role: "user", content: "A", timestamp: 1 });
		const item = backgroundJob();
		await host.service.execute(item.execution);
		item.finish();
		await host.service.wait(item.control.id, { timeoutMs: 1000 });
		expect(host.delivery.pending()).toHaveLength(1);
		// Leave the branch before the completion was delivered.
		manager.resetLeaf();
		await host.cancelOutsideBranch(null);
		expect(host.delivery.pending()).toEqual([]);
		expect(host.service.list()).toEqual([]);
		// Return to it: the pending completion is delivered, exactly once.
		manager.branch(branchA);
		await host.cancelOutsideBranch(branchA);
		expect(host.delivery.pending()).toHaveLength(1);
		open = true;
		host.delivery.schedule();
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
	});
});
