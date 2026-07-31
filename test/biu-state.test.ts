import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	archiveBiuCycle,
	BIU_MAX_TASKS,
	BIU_STATE_VERSION,
	type BiuMoveFile,
	type BiuState,
	createInitialBiuState,
	ensureBiuWorkspace,
	findActiveTask,
	findNextTask,
	getBiuPaths,
	getStageTransitionError,
	getTaskCounts,
	isValidTaskId,
	loadBiuState,
	saveBiuState,
	validateBiuState,
	wouldCreateCycle,
} from "../src/extensions/biu/state.ts";

let agentDir: string;
let cwd: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "biu-agent-"));
	cwd = await mkdtemp(join(tmpdir(), "biu-project-"));
});

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

function stateWithTasks(tasks: BiuState["tasks"]): BiuState {
	const state = createInitialBiuState();
	state.tasks = tasks;
	return state;
}

describe("biu paths", () => {
	test("encodes the project cwd like session storage", () => {
		const paths = getBiuPaths(cwd, agentDir);
		expect(paths.root.startsWith(join(agentDir, "biu"))).toBe(true);
		expect(paths.root).toContain("--");
		expect(paths.stateFile).toBe(join(paths.root, "biu.json"));
		expect(paths.specFile).toBe(join(paths.root, "SPEC.md"));
		expect(paths.tasksDir).toBe(join(paths.root, "tasks"));
		expect(paths.archivedDir).toBe(join(paths.root, "archived"));
	});

	test("different cwds map to different workspaces", () => {
		const other = join(cwd, "nested");
		expect(getBiuPaths(cwd, agentDir).root).not.toBe(getBiuPaths(other, agentDir).root);
	});
});

describe("biu state persistence", () => {
	test("load returns undefined when biu.json does not exist", async () => {
		expect(await loadBiuState(cwd, agentDir)).toBeUndefined();
	});

	test("save and load roundtrip", async () => {
		const state = createInitialBiuState();
		state.stage = "execute";
		state.spec = { status: "ready", title: "OAuth login", baselineCommit: "abc123" };
		state.tasks = [
			{ id: "TASK-api", title: "API", status: "completed", dependsOn: [] },
			{ id: "TASK-ui", title: "UI", status: "ready", dependsOn: ["TASK-api"] },
		];
		await saveBiuState(cwd, state, agentDir);
		expect(await loadBiuState(cwd, agentDir)).toEqual(state);
	});

	test("save is atomic and leaves no temp files", async () => {
		await saveBiuState(cwd, createInitialBiuState(), agentDir);
		await saveBiuState(cwd, createInitialBiuState(), agentDir);
		const paths = getBiuPaths(cwd, agentDir);
		const raw = await readFile(paths.stateFile, "utf8");
		expect(JSON.parse(raw).version).toBe(BIU_STATE_VERSION);
		expect(existsSync(`${paths.stateFile}.${process.pid}.tmp`)).toBe(false);
	});

	test("load throws a clear error on invalid JSON", async () => {
		const paths = getBiuPaths(cwd, agentDir);
		await mkdir(paths.root, { recursive: true });
		await writeFile(paths.stateFile, "not json", "utf8");
		await expect(loadBiuState(cwd, agentDir)).rejects.toThrow(/invalid JSON/);
	});

	test("ensureBiuWorkspace creates directories and a fresh state once", async () => {
		const first = await ensureBiuWorkspace(cwd, agentDir);
		expect(first.created).toBe(true);
		expect(existsSync(first.paths.tasksDir)).toBe(true);
		expect(existsSync(first.paths.archivedDir)).toBe(true);
		first.state.stage = "execute";
		first.state.tasks = [{ id: "TASK-a", title: "a", status: "ready", dependsOn: [] }];
		await saveBiuState(cwd, first.state, agentDir);
		const second = await ensureBiuWorkspace(cwd, agentDir);
		expect(second.created).toBe(false);
		expect(second.state.stage).toBe("execute");
	});

	test("ensureBiuWorkspace refuses to create a fresh state over leftover cycle files", async () => {
		await ensureBiuWorkspace(cwd, agentDir);
		const paths = getBiuPaths(cwd, agentDir);
		await writeFile(paths.specFile, "# SPEC: leftover\n", "utf8");
		await rm(paths.stateFile);
		await expect(ensureBiuWorkspace(cwd, agentDir)).rejects.toThrow(/leftover cycle files remain/);
		expect(existsSync(paths.specFile)).toBe(true);
		expect(existsSync(paths.stateFile)).toBe(false);

		await rm(paths.specFile);
		await writeFile(join(paths.tasksDir, "TASK-a.md"), "# TASK-a\n", "utf8");
		await expect(ensureBiuWorkspace(cwd, agentDir)).rejects.toThrow(/leftover cycle files remain/);
		expect(existsSync(join(paths.tasksDir, "TASK-a.md"))).toBe(true);
		expect(existsSync(paths.stateFile)).toBe(false);
	});
});

describe("validateBiuState", () => {
	test("rejects unsupported versions and bad stages", () => {
		expect(() => validateBiuState({ version: 99 })).toThrow(/unsupported version/);
		const state = { ...createInitialBiuState(), stage: "flying" };
		expect(() => validateBiuState(state)).toThrow(/stage/);
	});

	test("rejects duplicate task ids, invalid ids, and unknown dependencies", () => {
		const base = createInitialBiuState();
		expect(() =>
			validateBiuState({
				...base,
				tasks: [
					{ id: "TASK-a", title: "a", status: "ready", dependsOn: [] },
					{ id: "TASK-a", title: "b", status: "ready", dependsOn: [] },
				],
			}),
		).toThrow(/duplicate/);
		expect(() =>
			validateBiuState({ ...base, tasks: [{ id: "task a", title: "a", status: "ready", dependsOn: [] }] }),
		).toThrow(/invalid task id/);
		expect(() =>
			validateBiuState({ ...base, tasks: [{ id: "TASK-a", title: "a", status: "ready", dependsOn: ["TASK-x"] }] }),
		).toThrow(/unknown task/);
	});

	test("rejects oversized task lists", () => {
		const tasks = Array.from({ length: BIU_MAX_TASKS + 1 }, (_, index) => ({
			id: `TASK-${index}`,
			title: "t",
			status: "ready",
			dependsOn: [],
		}));
		expect(() => validateBiuState({ ...createInitialBiuState(), tasks })).toThrow(/maximum/);
	});

	test("rejects self-dependencies and dependency cycles on load", () => {
		const base = createInitialBiuState();
		expect(() =>
			validateBiuState({
				...base,
				tasks: [{ id: "TASK-a", title: "a", status: "ready", dependsOn: ["TASK-a"] }],
			}),
		).toThrow(/depends on itself/);
		expect(() =>
			validateBiuState({
				...base,
				tasks: [
					{ id: "TASK-a", title: "a", status: "ready", dependsOn: ["TASK-b"] },
					{ id: "TASK-b", title: "b", status: "ready", dependsOn: ["TASK-a"] },
				],
			}),
		).toThrow(/cycle involving "TASK-a"/);
	});
});

describe("task helpers", () => {
	test("isValidTaskId enforces the portable form", () => {
		expect(isValidTaskId("TASK-auth")).toBe(true);
		expect(isValidTaskId("TASK-a.b_c-1")).toBe(true);
		expect(isValidTaskId("TASK-")).toBe(false);
		expect(isValidTaskId("task-auth")).toBe(false);
		expect(isValidTaskId(`TASK-${"x".repeat(81)}`)).toBe(false);
	});

	test("findNextTask returns the first ready task whose dependencies completed", () => {
		const state = stateWithTasks([
			{ id: "TASK-a", title: "a", status: "completed", dependsOn: [] },
			{ id: "TASK-b", title: "b", status: "ready", dependsOn: ["TASK-c"] },
			{ id: "TASK-c", title: "c", status: "ready", dependsOn: ["TASK-a"] },
		]);
		expect(findNextTask(state)?.id).toBe("TASK-c");
	});

	test("findActiveTask returns the in-progress task", () => {
		const state = stateWithTasks([
			{ id: "TASK-a", title: "a", status: "ready", dependsOn: [] },
			{ id: "TASK-b", title: "b", status: "in_progress", dependsOn: [] },
		]);
		expect(findActiveTask(state)?.id).toBe("TASK-b");
		expect(getTaskCounts(state)).toEqual({ total: 2, ready: 1, inProgress: 1, completed: 0 });
	});

	test("wouldCreateCycle detects direct and transitive cycles", () => {
		const tasks = [
			{ id: "TASK-a", title: "a", status: "ready" as const, dependsOn: ["TASK-b"] },
			{ id: "TASK-b", title: "b", status: "ready" as const, dependsOn: [] },
		];
		expect(wouldCreateCycle(tasks, "TASK-b", ["TASK-a"])).toBe(true);
		expect(wouldCreateCycle(tasks, "TASK-b", [])).toBe(false);
		expect(wouldCreateCycle(tasks, "TASK-c", ["TASK-a"])).toBe(false);
	});
});

describe("stage transitions", () => {
	test("decompose requires a ready SPEC", () => {
		const state = createInitialBiuState();
		expect(getStageTransitionError(state, "decompose")).toMatch(/not ready/);
		state.spec.status = "ready";
		expect(getStageTransitionError(state, "decompose")).toBeUndefined();
	});

	test("execute requires registered tasks", () => {
		const state = createInitialBiuState();
		state.spec.status = "ready";
		expect(getStageTransitionError(state, "execute")).toMatch(/no tasks/);
		state.tasks = [{ id: "TASK-a", title: "a", status: "ready", dependsOn: [] }];
		expect(getStageTransitionError(state, "execute")).toBeUndefined();
	});

	test("same-stage moves are rejected and backward moves are free", () => {
		const state = createInitialBiuState();
		state.stage = "execute";
		expect(getStageTransitionError(state, "execute")).toMatch(/Already/);
		expect(getStageTransitionError(state, "interview")).toBeUndefined();
		expect(getStageTransitionError(state, "archive")).toBeUndefined();
	});
});

describe("archiveBiuCycle", () => {
	async function seedCycle(): Promise<void> {
		const { paths, state } = await ensureBiuWorkspace(cwd, agentDir);
		state.stage = "archive";
		state.spec = { status: "ready", title: "Cycle", baselineCommit: "none" };
		state.tasks = [{ id: "TASK-a", title: "a", status: "completed", dependsOn: [] }];
		await saveBiuState(cwd, state, agentDir);
		await writeFile(paths.specFile, "# SPEC: Cycle\n", "utf8");
		await writeFile(paths.summaryFile, "# Summary: Cycle\n", "utf8");
		await writeFile(join(paths.tasksDir, "TASK-a.md"), "# TASK-a\n", "utf8");
	}

	test("requires SPEC.md and Summary.md", async () => {
		await ensureBiuWorkspace(cwd, agentDir);
		await expect(archiveBiuCycle(cwd, "x", agentDir)).rejects.toThrow(/SPEC\.md/);
		const paths = getBiuPaths(cwd, agentDir);
		await writeFile(paths.specFile, "# SPEC\n", "utf8");
		await expect(archiveBiuCycle(cwd, "x", agentDir)).rejects.toThrow(/Summary\.md/);
	});

	test("moves the cycle into a dated directory and resets state", async () => {
		await seedCycle();
		const now = new Date("2026-07-31T12:00:00Z");
		const result = await archiveBiuCycle(cwd, "oauth 登录", agentDir, now);
		expect(result.archiveName).toBe("2026-07-31-oauth-登录");
		const paths = getBiuPaths(cwd, agentDir);
		expect(existsSync(join(result.archivedPath, "SPEC.md"))).toBe(true);
		expect(existsSync(join(result.archivedPath, "Summary.md"))).toBe(true);
		expect(existsSync(join(result.archivedPath, "tasks", "TASK-a.md"))).toBe(true);
		expect(existsSync(paths.specFile)).toBe(false);
		expect(existsSync(paths.summaryFile)).toBe(false);
		expect(existsSync(paths.tasksDir)).toBe(true);
		const fresh = await loadBiuState(cwd, agentDir);
		expect(fresh?.stage).toBe("interview");
		expect(fresh?.tasks).toEqual([]);
		expect(fresh?.spec.status).toBe("draft");
	});

	test("suffixes colliding archive names", async () => {
		await seedCycle();
		const now = new Date("2026-07-31T12:00:00Z");
		const first = await archiveBiuCycle(cwd, "cycle", agentDir, now);
		expect(first.archiveName).toBe("2026-07-31-cycle");
		await seedCycle();
		const second = await archiveBiuCycle(cwd, "cycle", agentDir, now);
		expect(second.archiveName).toBe("2026-07-31-cycle-02");
	});

	test("sanitizes unsafe shortnames and rejects empty ones", async () => {
		await seedCycle();
		const now = new Date("2026-07-31T12:00:00Z");
		const result = await archiveBiuCycle(cwd, '  a/b\\c:d*e?"f<g>h|i  ', agentDir, now);
		expect(result.archiveName).toBe("2026-07-31-a-b-c-d-e-f-g-h-i");
		await seedCycle();
		await expect(archiveBiuCycle(cwd, "///***", agentDir, now)).rejects.toThrow(/empty after sanitization/);
	});

	test("rolls back already-moved files when a move fails mid-archive", async () => {
		await seedCycle();
		let calls = 0;
		const failingMove: BiuMoveFile = async (from, to) => {
			calls++;
			if (calls === 3) throw new Error("simulated move failure");
			await rename(from, to);
			return true;
		};
		const now = new Date("2026-07-31T12:00:00Z");
		await expect(archiveBiuCycle(cwd, "cycle", agentDir, now, failingMove)).rejects.toThrow(/simulated move failure/);
		const paths = getBiuPaths(cwd, agentDir);
		expect(existsSync(paths.specFile)).toBe(true);
		expect(existsSync(paths.summaryFile)).toBe(true);
		expect(existsSync(join(paths.tasksDir, "TASK-a.md"))).toBe(true);
		expect((await loadBiuState(cwd, agentDir))?.stage).toBe("archive");
		expect(await readdir(paths.archivedDir)).toHaveLength(0);
	});

	test("rolls back when the state write fails after all files moved", async () => {
		await seedCycle();
		const paths = getBiuPaths(cwd, agentDir);
		// Occupy the temp-file path so saveBiuState's writeFile fails after the
		// moves; the recreated empty tasks/ directory must not block the
		// move-back on Windows.
		await mkdir(`${paths.stateFile}.${process.pid}.tmp`);
		const now = new Date("2026-07-31T12:00:00Z");
		const failure = await archiveBiuCycle(cwd, "cycle", agentDir, now).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
		expect(failure?.message).toMatch(/EISDIR|EPERM|EACCES/);
		expect(failure?.message).not.toMatch(/Rollback incomplete/);
		expect(existsSync(paths.specFile)).toBe(true);
		expect(existsSync(paths.summaryFile)).toBe(true);
		expect(existsSync(join(paths.tasksDir, "TASK-a.md"))).toBe(true);
		expect((await loadBiuState(cwd, agentDir))?.stage).toBe("archive");
		expect(await readdir(paths.archivedDir)).toHaveLength(0);
	});
});
