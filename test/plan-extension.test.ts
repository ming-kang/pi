import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	buildPlanModePrompt,
	PLAN_ALLOWED_SUBAGENT,
	PLAN_BLOCKED_TOOLS,
	PLAN_EXPLORE_TOOLS,
} from "../src/extensions/plan/constants.ts";
import { findDisallowedSubagentProfile } from "../src/extensions/plan/index.ts";
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
import {
	buildPlanDocument,
	formatPlanFileStamp,
	getPlansDir,
	listProjectPlanFiles,
	resolvePlanFileName,
	savePlanFile,
	slugifyTitle,
} from "../src/extensions/plan/storage.ts";

describe("plan storage", () => {
	test("slugifyTitle produces bounded ascii slugs", () => {
		expect(slugifyTitle("Add Cache Layer!")).toBe("add-cache-layer");
		expect(slugifyTitle("   ")).toBe("plan");
		expect(slugifyTitle("计划")).toBe("plan");
		expect(slugifyTitle("x".repeat(100)).length).toBeLessThanOrEqual(40);
		expect(slugifyTitle(`${"a".repeat(39)}-b`)).not.toMatch(/-$/);
	});

	test("formatPlanFileStamp is local-time YYYYMMDD-HHmm", () => {
		expect(formatPlanFileStamp(new Date(2026, 6, 28, 9, 5))).toBe("20260728-0905");
		expect(formatPlanFileStamp(new Date(2026, 11, 3, 23, 59))).toBe("20261203-2359");
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

	describe("on-disk layout", () => {
		let agentDir: string;
		let projectDir: string;
		const originalEnv = process.env.PI_CODING_AGENT_DIR;

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "pi-plan-test-"));
			projectDir = mkdtempSync(join(tmpdir(), "pi-plan-proj-"));
			process.env.PI_CODING_AGENT_DIR = agentDir;
		});

		afterEach(() => {
			if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projectDir, { recursive: true, force: true });
		});

		test("getPlansDir groups by project like sessions", () => {
			const dir = getPlansDir(projectDir);
			expect(dirname(dir)).toBe(join(agentDir, "plans"));
			expect(basename(dir)).toMatch(/^--.+--$/);
			expect(basename(dir)).not.toContain(":");
		});

		test("resolvePlanFileName appends -2, -3 on collisions", () => {
			expect(resolvePlanFileName(projectDir, "20260728-0905-a")).toBe("20260728-0905-a.md");
			writeFileSync(join(projectDir, "20260728-0905-a.md"), "");
			expect(resolvePlanFileName(projectDir, "20260728-0905-a")).toBe("20260728-0905-a-2.md");
			writeFileSync(join(projectDir, "20260728-0905-a-2.md"), "");
			expect(resolvePlanFileName(projectDir, "20260728-0905-a")).toBe("20260728-0905-a-3.md");
		});

		test("savePlanFile writes timestamped files under the project dir", () => {
			const first = savePlanFile({ sessionId: "s1", title: "First Plan", plan: "# one", cwd: projectDir });
			const second = savePlanFile({ sessionId: "s1", title: "First Plan", plan: "# two", cwd: projectDir });
			expect(dirname(first)).toBe(getPlansDir(projectDir));
			expect(basename(first)).toMatch(/^\d{8}-\d{4}-first-plan\.md$/);
			expect(basename(second)).toMatch(/^\d{8}-\d{4}-first-plan(-\d+)?\.md$/);
			expect(basename(second)).not.toBe(basename(first));
			expect(readFileSync(second, "utf-8")).toContain("# two");
			expect(readFileSync(second, "utf-8")).toContain("session: s1");
		});

		test("listProjectPlanFiles returns newest first and tolerates a missing dir", () => {
			expect(listProjectPlanFiles(projectDir)).toEqual([]);
			savePlanFile({ sessionId: "s1", title: "A Plan", plan: "#", cwd: projectDir });
			savePlanFile({ sessionId: "s1", title: "B Plan", plan: "#", cwd: projectDir });
			const files = listProjectPlanFiles(projectDir);
			expect(files).toHaveLength(2);
			expect(files.map((file) => basename(file))).toEqual([...files.map((file) => basename(file))].sort().reverse());
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

	test("isPlanState accepts current and legacy shapes, rejects malformed data", () => {
		expect(isPlanState(undefined)).toBe(false);
		expect(isPlanState({ planning: true })).toBe(false);
		expect(isPlanState({ planning: true, awaitingCompact: false, toolSnapshot: [], planFiles: [] })).toBe(true);
		// Legacy entries recorded removals instead of a snapshot.
		expect(isPlanState({ planning: true, awaitingCompact: false, removedTools: ["edit"], planFiles: [] })).toBe(true);
	});

	test("replayPlanFromBranch returns the latest plan-mode entry, or undefined", () => {
		const entry = (data: unknown) => ({ type: "custom", customType: "plan-mode", data });
		const state = { planning: true, awaitingCompact: false, toolSnapshot: ["read", "edit"], planFiles: ["/p/a.md"] };
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

	test("replayPlanFromBranch maps legacy removedTools entries to an empty snapshot", () => {
		const legacy = {
			planning: true,
			awaitingCompact: false,
			removedTools: ["edit", "write"],
			planFiles: ["/p/01-a.md"],
		};
		const branch = [{ type: "custom", customType: "plan-mode", data: legacy }];
		const replayed = replayPlanFromBranch({ sessionManager: { getBranch: () => branch } });
		expect(replayed).toEqual({ planning: true, awaitingCompact: false, toolSnapshot: [], planFiles: ["/p/01-a.md"] });
	});
});

describe("plan prompt and guards", () => {
	test("blocked tools are edit/write only; exploration tools stay available", () => {
		expect(PLAN_BLOCKED_TOOLS.has("edit")).toBe(true);
		expect(PLAN_BLOCKED_TOOLS.has("write")).toBe(true);
		for (const name of ["read", "grep", "find", "ls", "bash", "subagent"]) {
			expect(PLAN_BLOCKED_TOOLS.has(name)).toBe(false);
		}
		expect([...PLAN_EXPLORE_TOOLS]).toEqual(["read", "grep", "find", "ls", "bash"]);
	});

	test("prompt states the bash and subagent constraints", () => {
		const prompt = buildPlanModePrompt([]);
		expect(prompt).toContain("read-only inspection only");
		expect(prompt).toContain(`agent: "${PLAN_ALLOWED_SUBAGENT}"`);
		expect(prompt).not.toContain("bash, and subagent are unavailable");
	});

	test("prompt lists saved plans only when present", () => {
		expect(buildPlanModePrompt([])).not.toContain("Plans already saved");
		const withPlans = buildPlanModePrompt(["/p/01-a.md"]);
		expect(withPlans).toContain("Plans already saved");
		expect(withPlans).toContain("/p/01-a.md");
	});

	test("findDisallowedSubagentProfile allows explorer only, defaulting omitted agents to general", () => {
		expect(findDisallowedSubagentProfile({ agent: "explorer", prompt: "look" })).toBeUndefined();
		expect(findDisallowedSubagentProfile({ agent: "general", prompt: "do" })).toBe("general");
		expect(findDisallowedSubagentProfile({ prompt: "do" })).toBe("general");
		expect(findDisallowedSubagentProfile({ agent: null, prompt: "do" })).toBe("general");
		expect(findDisallowedSubagentProfile(undefined)).toBe("general");
		expect(findDisallowedSubagentProfile({ agent: "custom-writer", prompt: "do" })).toBe("custom-writer");
		expect(
			findDisallowedSubagentProfile({
				tasks: [
					{ agent: "explorer", prompt: "a", description: "a" },
					{ agent: "explorer", prompt: "b", description: "b" },
				],
			}),
		).toBeUndefined();
		expect(
			findDisallowedSubagentProfile({
				tasks: [
					{ agent: "explorer", prompt: "a", description: "a" },
					{ prompt: "b", description: "b" },
				],
			}),
		).toBe("general");
	});
});
