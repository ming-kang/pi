import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundService } from "../src/core/background/service.ts";
import { BackgroundSession } from "../src/core/background/session.ts";
import type {
	BackgroundCompletion,
	BackgroundControl,
	BackgroundKind,
	BackgroundTask,
} from "../src/core/background/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const result = (text: string): AgentToolResult<undefined> => ({
	content: [{ type: "text", text }],
	details: undefined,
});
const services: BackgroundService[] = [];
const hosts: BackgroundSession[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.dispose();
	for (const service of services.splice(0)) service.close();
});
function service(maxHistory = 32) {
	const instance = new BackgroundService({ enabled: true, maxHistory, maxActive: 1 });
	services.push(instance);
	return instance;
}
function launch(bg: BackgroundService, kind: BackgroundKind, background = false, text = "saved report") {
	let control!: BackgroundControl<undefined>;
	let finish!: () => void;
	const completion = new Promise<BackgroundCompletion<undefined>>((resolve) => {
		finish = () => resolve({ result: result(text) });
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
async function complete(bg: BackgroundService, kind: BackgroundKind, background = false, text?: string) {
	const run = launch(bg, kind, background, text);
	if (background) expect((await run.caller).kind).toBe("background");
	run.finish();
	await bg.wait(run.control.id);
	await run.caller;
	bg.markDelivered(run.control.id);
	return run.control.id;
}
function saved(id: string, endedAt: number, overrides: Partial<BackgroundTask> = {}) {
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
			result: result(id),
			...overrides,
		} satisfies BackgroundTask,
	};
}

describe("independent foreground shell history", () => {
	it.each([
		{ kind: "bash" as const, background: true },
		{ kind: "subagent" as const, background: true },
		{ kind: "subagent" as const, background: false },
	])("keeps completed $kind, background=$background after 100 foreground shells", async ({ kind, background }) => {
		const bg = service();
		const id = await complete(bg, kind, background);
		for (let i = 0; i < 100; i++) await complete(bg, "bash");
		expect(bg.list()).toHaveLength(33);
		expect(bg.get(id)).toMatchObject({ status: "completed", mode: background ? "background" : "foreground" });
		expect((await bg.read(id)).text).toBe("saved report");
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("evicts only the oldest delivered record in the history that exceeds its allowance", async () => {
		const bg = service(2);
		const firstShell = await complete(bg, "bash");
		const secondShell = await complete(bg, "bash");
		const firstTask = await complete(bg, "subagent");
		const secondTask = await complete(bg, "bash", true);
		const thirdTask = await complete(bg, "subagent", true);
		expect(() => bg.get(firstTask)).toThrow("Unknown");
		expect(bg.get(firstShell).status).toBe("completed");
		const thirdShell = await complete(bg, "bash");
		expect(() => bg.get(firstShell)).toThrow("Unknown");
		expect(bg.list().map((task) => task.id)).toEqual([secondShell, secondTask, thirdTask, thirdShell]);
	});

	it("retains a detached shell with background history and protects its managed log", async () => {
		const bg = service(1);
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
		await complete(bg, "subagent");
		expect(() => bg.get(run.control.id)).toThrow("Unknown");
		await bg.shutdown();
		expect(cleaned).toBe(true);
	});

	it.each([false, true])("restores both histories independently, reverse input=%s", async (reverse) => {
		const bg = service();
		const records = [
			saved("subagent-background", 1, { kind: "subagent", mode: "background" }),
			saved("subagent-foreground", 2, { kind: "subagent" }),
			...Array.from({ length: 100 }, (_, index) => saved(`bash-${index}`, index + 3)),
		];
		bg.restoreHistory(reverse ? records.reverse() : records);
		expect(bg.list()).toHaveLength(34);
		expect((await bg.read("subagent-background")).text).toBe("subagent-background");
		expect((await bg.read("subagent-foreground")).text).toBe("subagent-foreground");
		expect(() => bg.get("bash-67")).toThrow("Unknown");
		expect(bg.get("bash-68").status).toBe("completed");
		expect(bg.pendingNotifications()).toEqual([]);
	});

	it("restores task history when runtime foreground shell history is already full", async () => {
		const bg = service(1);
		const id = await complete(bg, "bash");
		bg.restoreHistory([
			saved("bash-extra", 3),
			saved("subagent-restored", 1, { kind: "subagent", mode: "background" }),
		]);
		expect(bg.list().map((task) => task.id)).toEqual([id, "subagent-restored"]);
		expect((await bg.read(id)).text).toBe("saved report");
	});

	it("prefers task snapshots when protected records leave only one restoration slot", () => {
		const bg = service(1);
		const releases: Array<() => void> = [];
		for (let i = 0; i < 3; i++) {
			const record = saved(`bash-pinned-${i}`, i);
			bg.restoreHistory([record]);
			releases.push(bg.pin(record.task.id));
		}
		bg.restoreHistory([saved("bash-newer-shell", 100), saved("subagent-older-task", 1, { kind: "subagent" })]);
		expect(bg.list()).toHaveLength(4);
		expect(bg.get("subagent-older-task").status).toBe("completed");
		expect(() => bg.get("bash-newer-shell")).toThrow("Unknown");
		for (const release of releases) release();
		expect(bg.list()).toHaveLength(2);
	});

	it("releases and restores both histories when returning to a branch", async () => {
		const bg = service(1);
		const branchA = [
			saved("subagent-A", 1, { kind: "subagent", anchorId: "A" }),
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

	it("restores completed subagents from the session journal after runtime replacement", async () => {
		const manager = SessionManager.inMemory();
		const host = new BackgroundSession({
			manager,
			role: "main",
			canDeliver: () => false,
			deliver: async () => {},
			onEntry: () => {},
			onError: (_event, message) => {
				throw new Error(message);
			},
		});
		hosts.push(host);
		host.setEnabled(true);
		const background = await complete(host.service, "subagent", true);
		const foreground = await complete(host.service, "subagent");
		for (let i = 0; i < 100; i++) await complete(host.service, "bash");
		const entries = manager.getEntries().length;
		await host.service.shutdown();
		host.replaceService();
		expect(host.service.list()).toHaveLength(34);
		for (const id of [background, foreground]) expect((await host.service.read(id)).text).toBe("saved report");
		expect(host.service.pendingNotifications()).toEqual([]);
		expect(manager.getEntries()).toHaveLength(entries);
	});
});
