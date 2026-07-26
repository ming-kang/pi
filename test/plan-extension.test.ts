import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildPlanModePrompt, PLAN_BLOCKED_TOOLS } from "../src/extensions/plan/constants.ts";
import {
	clonePlanState,
	disposePlanSession,
	EMPTY_PLAN_STATE,
	getPlanState,
	isPlanState,
	replacePlanState,
	replayPlanFromBranch,
	setActivePlanSession,
} from "../src/extensions/plan/state.ts";
import { buildPlanDocument, nextPlanNumber, savePlanFile, slugifyTitle } from "../src/extensions/plan/storage.ts";

describe("plan storage", () => {
	test("slugifyTitle produces bounded ascii slugs", () => {
		expect(slugifyTitle("Add Cache Layer!")).toBe("add-cache-layer");
		expect(slugifyTitle("   ")).toBe("plan");
		expect(slugifyTitle("计划")).toBe("plan");
		expect(slugifyTitle("x".repeat(100)).length).toBeLessThanOrEqual(40);
		expect(slugifyTitle(`${"a".repeat(39)}-b`)).not.toMatch(/-$/);
	});

	test("nextPlanNumber is monotonic over existing NN- names", () => {
		expect(nextPlanNumber([])).toBe(1);
		expect(nextPlanNumber(["01-a.md", "03-b.md", "notes.txt"])).toBe(4);
		expect(nextPlanNumber(["10-a.md", "02-b.md"])).toBe(11);
	});

	test("buildPlanDocument writes frontmatter with escaped fields", () => {
		const doc = buildPlanDocument({
			sessionId: "sid",
			title: 'a "quoted" title',
			plan: "# Goal\n\nDo the thing.\n",
			cwd: "C:\\work\\repo",
			revises: "01-old.md",
			createdIso: "2026-07-26T00:00:00.000Z",
		});
		expect(doc).toContain('title: "a \\"quoted\\" title"');
		expect(doc).toContain("session: sid");
		expect(doc).toContain('revises: "01-old.md"');
		expect(doc.endsWith("Do the thing.\n")).toBe(true);
	});

	describe("savePlanFile", () => {
		let agentDir: string;
		const originalEnv = process.env.PI_CODING_AGENT_DIR;

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
			process.env.PI_CODING_AGENT_DIR = agentDir;
		});

		afterEach(() => {
			if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalEnv;
			rmSync(agentDir, { recursive: true, force: true });
		});

		test("writes sequentially numbered files under plans/<sessionId>", () => {
			const first = savePlanFile({ sessionId: "s1", title: "First Plan", plan: "# one", cwd: "/w" });
			const second = savePlanFile({ sessionId: "s1", title: "Second Plan", plan: "# two", cwd: "/w" });
			expect(basename(first)).toBe("01-first-plan.md");
			expect(basename(second)).toBe("02-second-plan.md");
			expect(first).toContain(join(agentDir, "plans", "s1"));
			expect(readFileSync(second, "utf-8")).toContain("# two");
		});
	});
});

describe("plan state", () => {
	afterEach(() => {
		disposePlanSession("sid-a");
		disposePlanSession("sid-b");
	});

	test("state is bucketed per session id", () => {
		setActivePlanSession("sid-a");
		replacePlanState({ ...clonePlanState(EMPTY_PLAN_STATE), planning: true });
		setActivePlanSession("sid-b");
		expect(getPlanState().planning).toBe(false);
		setActivePlanSession("sid-a");
		expect(getPlanState().planning).toBe(true);
	});

	test("isPlanState rejects malformed entry data", () => {
		expect(isPlanState(undefined)).toBe(false);
		expect(isPlanState({ planning: true })).toBe(false);
		expect(isPlanState({ planning: true, awaitingCompact: false, removedTools: [], planFiles: [] })).toBe(true);
	});

	test("replayPlanFromBranch returns the latest plan-mode entry, or undefined", () => {
		const entry = (data: unknown) => ({ type: "custom", customType: "plan-mode", data });
		const state = { planning: true, awaitingCompact: false, removedTools: ["edit"], planFiles: ["/p/01-a.md"] };
		const branch = [
			{ type: "message" },
			entry({ ...state, planning: false }),
			{ type: "custom", customType: "other", data: {} },
			entry(state),
			{ type: "message" },
		];
		const replayed = replayPlanFromBranch({ sessionManager: { getBranch: () => branch } });
		expect(replayed).toEqual(state);

		const empty = replayPlanFromBranch({ sessionManager: { getBranch: () => [{ type: "message" }] } });
		expect(empty).toBeUndefined();

		const malformed = replayPlanFromBranch({ sessionManager: { getBranch: () => [entry({ bogus: true })] } });
		expect(malformed).toBeUndefined();
	});
});

describe("plan prompt", () => {
	test("blocked tools cover write escapes including subagent", () => {
		for (const name of ["edit", "write", "bash", "subagent"]) {
			expect(PLAN_BLOCKED_TOOLS.has(name)).toBe(true);
		}
		expect(PLAN_BLOCKED_TOOLS.has("read")).toBe(false);
	});

	test("prompt lists saved plans only when present", () => {
		expect(buildPlanModePrompt([])).not.toContain("Plans already saved");
		const withPlans = buildPlanModePrompt(["/p/01-a.md"]);
		expect(withPlans).toContain("Plans already saved");
		expect(withPlans).toContain("/p/01-a.md");
	});
});
