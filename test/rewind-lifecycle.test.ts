import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const roots = vi.hoisted(() => ({ root: `${process.cwd()}/.rewind-lifecycle-test` }));

vi.mock("../src/extensions/rewind/paths.ts", () => ({
	rewindBackupsRoot: () => `${roots.root}/backups`,
	rewindConfigPath: () => `${roots.root}/config.json`,
	sessionsDirectory: () => `${roots.root}/sessions`,
}));

import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import rewind from "../src/extensions/rewind/index.ts";

interface Node {
	id: string;
	parentId: string | null;
	type: string;
	message?: { role: string };
}

type Hook = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function makeHarness() {
	const hooks = new Map<string, Hook>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on: (name: string, hook: Hook) => hooks.set(name, hook),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	rewind(pi);
	return { hooks, appended };
}

describe("rewind run lifecycle", () => {
	const cwd = join(roots.root, "cwd");
	const sid = "lifecycle-session";
	const f = join(cwd, "f.txt");
	let branch: Node[];
	let leafId: string | null;
	let ctx: ExtensionContext;

	beforeEach(async () => {
		rmSync(roots.root, { recursive: true, force: true });
		mkdirSync(join(roots.root, "sessions"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(f, "before", "utf8");
		branch = [{ id: "root", parentId: null, type: "message", message: { role: "assistant" } }];
		leafId = "root";
		const sessionManager = {
			getSessionId: () => sid,
			getSessionDir: () => join(roots.root, "sessions"),
			getSessionFile: () => undefined,
			getEntries: () => branch,
			getBranch: () => branch,
			getLeafId: () => leafId,
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
		};
		ctx = {
			cwd,
			hasUI: false,
			mode: "json",
			sessionManager,
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;
	});

	afterAll(() => {
		rmSync(roots.root, { recursive: true, force: true });
	});

	test("does not persist a custom-triggered run even if it appends a user entry", async () => {
		const harness = makeHarness();
		await harness.hooks.get("session_start")?.({ reason: "new" }, ctx);

		await harness.hooks.get("before_agent_start")?.({ prompt: "normal" }, ctx);
		await harness.hooks.get("agent_start")?.({}, ctx);
		branch.push({ id: "u1", parentId: "root", type: "message", message: { role: "user" } });
		leafId = "u1";
		await harness.hooks.get("tool_call")?.({ toolName: "edit", input: { path: "f.txt" } }, ctx);
		writeFileSync(f, "normal", "utf8");
		await harness.hooks.get("agent_settled")?.({}, ctx);
		expect(harness.appended).toHaveLength(1);

		branch.push({ id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } });
		leafId = "a1";
		await harness.hooks.get("agent_start")?.({}, ctx);
		await harness.hooks.get("tool_call")?.({ toolName: "edit", input: { path: "f.txt" } }, ctx);
		writeFileSync(f, "custom", "utf8");
		branch.push({ id: "u2", parentId: "a1", type: "message", message: { role: "user" } });
		leafId = "u2";
		await harness.hooks.get("agent_settled")?.({}, ctx);

		expect(harness.appended).toHaveLength(1);
		const backupDir = join(roots.root, "backups", sid);
		expect(existsSync(backupDir)).toBe(true);
		expect(readdirSync(backupDir)).toHaveLength(1);
	});

	test("does not let a custom run inherit eligibility from an interrupted run", async () => {
		const harness = makeHarness();
		await harness.hooks.get("session_start")?.({ reason: "new" }, ctx);
		await harness.hooks.get("before_agent_start")?.({ prompt: "interrupted" }, ctx);
		await harness.hooks.get("agent_start")?.({}, ctx);
		await harness.hooks.get("tool_call")?.({ toolName: "edit", input: { path: "f.txt" } }, ctx);
		writeFileSync(f, "interrupted", "utf8");

		// No agent_settled for the prior run. A fresh agent_start without a
		// preparation marker identifies the next custom-triggered run.
		await harness.hooks.get("agent_start")?.({}, ctx);
		branch.push({ id: "u1", parentId: "root", type: "message", message: { role: "user" } });
		leafId = "u1";
		await harness.hooks.get("agent_settled")?.({}, ctx);

		expect(harness.appended).toHaveLength(0);
	});
});
