import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	archiveBiuCycle,
	BIU_MAX_SNAPSHOT_TASKS,
	detectSpecReadyTransition,
	getBiuFocus,
	getBiuPaths,
	isBiuUri,
	loadBiuSnapshot,
	resolveBiuUri,
	sanitizeShortname,
	toBiuUri,
} from "../src/extensions/biu/workspace.ts";

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

async function writeWorkspaceFile(relative: string, content: string): Promise<void> {
	const paths = getBiuPaths(cwd, agentDir);
	const target = join(paths.root, relative);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, content, "utf8");
}

function specContent(status: string, title = "OAuth login", baseline = "abc123"): string {
	return `---\ntitle: ${title}\nstatus: ${status}\nbaseline_commit: ${baseline}\n---\n\n# SPEC: ${title}\n`;
}

function taskContent(title: string, status: string, dependsOn: string[] = []): string {
	const deps = dependsOn.length > 0 ? `[${dependsOn.join(", ")}]` : "[]";
	return `---\ntitle: ${title}\nstatus: ${status}\ndepends_on: ${deps}\n---\n\n# ${title}\n`;
}

describe("biu:// resolution", () => {
	test("recognizes the scheme", () => {
		expect(isBiuUri("biu://SPEC.md")).toBe(true);
		expect(isBiuUri("src/index.ts")).toBe(false);
		expect(isBiuUri("/abs/biu")).toBe(false);
	});

	test("resolves workspace-relative paths", () => {
		const paths = getBiuPaths(cwd, agentDir);
		expect(resolveBiuUri("biu://SPEC.md", cwd, agentDir)).toEqual({ ok: true, path: paths.specFile });
		expect(resolveBiuUri("biu://tasks/TASK-api.md", cwd, agentDir)).toEqual({
			ok: true,
			path: join(paths.tasksDir, "TASK-api.md"),
		});
		expect(resolveBiuUri("biu://", cwd, agentDir)).toEqual({ ok: true, path: paths.root });
	});

	test("normalizes backslashes and dot segments", () => {
		const paths = getBiuPaths(cwd, agentDir);
		expect(resolveBiuUri("biu://tasks\\TASK-api.md", cwd, agentDir)).toEqual({
			ok: true,
			path: join(paths.tasksDir, "TASK-api.md"),
		});
		expect(resolveBiuUri("biu://./tasks//TASK-api.md", cwd, agentDir)).toEqual({
			ok: true,
			path: join(paths.tasksDir, "TASK-api.md"),
		});
	});

	test("rejects escapes and rooted paths", () => {
		expect(resolveBiuUri("biu://../elsewhere", cwd, agentDir).ok).toBe(false);
		expect(resolveBiuUri("biu://tasks/../../elsewhere", cwd, agentDir).ok).toBe(false);
		expect(resolveBiuUri("biu:///etc/passwd", cwd, agentDir).ok).toBe(false);
		expect(resolveBiuUri("biu://C:/temp/x", cwd, agentDir).ok).toBe(false);
		expect(resolveBiuUri("biu://~otheruser/x", cwd, agentDir).ok).toBe(false);
		expect(resolveBiuUri("SPEC.md", cwd, agentDir).ok).toBe(false);
	});

	test("formats biu:// URIs", () => {
		expect(toBiuUri("SPEC.md")).toBe("biu://SPEC.md");
		expect(toBiuUri("tasks", "TASK-api.md")).toBe("biu://tasks/TASK-api.md");
	});
});

describe("sanitizeShortname", () => {
	test("replaces separators and forbidden characters", () => {
		expect(sanitizeShortname("OAuth login flow")).toBe("OAuth-login-flow");
		expect(sanitizeShortname('a<b>c:d"e/f\\g|h?i*j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	test("drops control characters and trims dashes and dots", () => {
		expect(sanitizeShortname("\u0000bad\u001fname\u007f")).toBe("badname");
		expect(sanitizeShortname("--.name.--")).toBe("name");
	});

	test("preserves non-ASCII titles and caps the length", () => {
		expect(sanitizeShortname("登录 流程")).toBe("登录-流程");
		expect(sanitizeShortname("x".repeat(200))).toHaveLength(60);
		expect(sanitizeShortname("  ")).toBe("");
	});
});

describe("loadBiuSnapshot", () => {
	test("empty workspace derives the plan stage", async () => {
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("plan");
		expect(snapshot.spec).toEqual({
			exists: false,
			status: "unknown",
			title: null,
			baselineCommit: null,
			execution: null,
		});
		expect(snapshot.summaryExists).toBe(false);
		expect(snapshot.tasks).toEqual([]);
		expect(snapshot.focus).toEqual({ kind: "none" });
		expect(snapshot.problems).toEqual([]);
	});

	test("draft SPEC stays in plan and carries frontmatter metadata", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("draft"));
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("plan");
		expect(snapshot.spec).toEqual({
			exists: true,
			status: "draft",
			title: "OAuth login",
			baselineCommit: "abc123",
			execution: null,
		});
		expect(snapshot.problems).toEqual([]);
	});

	test("parses the execution frontmatter field", async () => {
		await writeWorkspaceFile("SPEC.md", "---\ntitle: T\nstatus: draft\nexecution: tasks\n---\n\n# SPEC\n");
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.spec.execution).toBe("tasks");
		expect(snapshot.problems).toEqual([]);
	});

	test("invalid execution degrades to null with a problem", async () => {
		await writeWorkspaceFile("SPEC.md", "---\ntitle: T\nstatus: draft\nexecution: parallel\n---\n\n# SPEC\n");
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.spec.execution).toBeNull();
		expect(snapshot.problems.some((problem) => problem.includes('"execution"'))).toBe(true);
	});

	test("ready SPEC without tasks derives execute", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("execute");
		expect(snapshot.counts.total).toBe(0);
	});

	test("tasks drive counts, focus, and dependency gating", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await writeWorkspaceFile("tasks/TASK-a.md", taskContent("API", "completed"));
		await writeWorkspaceFile("tasks/TASK-b.md", taskContent("UI", "ready", ["TASK-a.md"]));
		await writeWorkspaceFile("tasks/TASK-c.md", taskContent("Docs", "ready", ["TASK-b"]));

		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("execute");
		expect(snapshot.counts).toEqual({ total: 3, ready: 2, inProgress: 0, completed: 1, unknown: 0 });
		expect(snapshot.focus).toEqual({
			kind: "next",
			task: { id: "TASK-b", title: "UI", status: "ready", dependsOn: ["TASK-a"] },
		});
	});

	test("an in_progress task takes focus over ready tasks", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await writeWorkspaceFile("tasks/TASK-a.md", taskContent("API", "ready"));
		await writeWorkspaceFile("tasks/TASK-b.md", taskContent("UI", "in_progress"));
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.focus.kind).toBe("active");
		expect(snapshot.focus.kind === "active" && snapshot.focus.task.id).toBe("TASK-b");
	});

	test("all tasks completed derives archive", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await writeWorkspaceFile("tasks/TASK-a.md", taskContent("API", "completed"));
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("archive");
		expect(snapshot.focus).toEqual({ kind: "allDone" });
	});

	test("an existing Summary.md derives archive regardless of tasks", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await writeWorkspaceFile("Summary.md", "---\ntitle: Done\nhead_commit: def456\n---\n\n# Summary\n");
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("archive");
		expect(snapshot.summaryExists).toBe(true);
	});

	test("malformed frontmatter degrades to unknown with problems", async () => {
		await writeWorkspaceFile("SPEC.md", "---\nstatus: [broken\n---\n\n# SPEC\n");
		await writeWorkspaceFile("tasks/TASK-a.md", "# no frontmatter at all\n");
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("plan");
		expect(snapshot.spec.status).toBe("unknown");
		expect(snapshot.tasks[0]).toEqual({ id: "TASK-a", title: "TASK-a", status: "unknown", dependsOn: [] });
		expect(snapshot.counts.unknown).toBe(1);
		expect(snapshot.problems.length).toBeGreaterThanOrEqual(2);
	});

	test("bounds the number of tasks in the snapshot", async () => {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		for (let index = 0; index < BIU_MAX_SNAPSHOT_TASKS + 1; index++) {
			await writeWorkspaceFile(
				`tasks/TASK-${String(index).padStart(3, "0")}.md`,
				taskContent(`Task ${index}`, "ready"),
			);
		}
		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.tasks).toHaveLength(BIU_MAX_SNAPSHOT_TASKS);
		expect(snapshot.problems.some((problem) => problem.includes("snapshot limit"))).toBe(true);
	});
});

describe("getBiuFocus", () => {
	test("unknown-status dependencies block downstream tasks", () => {
		const focus = getBiuFocus([
			{ id: "TASK-a", title: "a", status: "unknown", dependsOn: [] },
			{ id: "TASK-b", title: "b", status: "ready", dependsOn: ["TASK-a"] },
		]);
		expect(focus).toEqual({ kind: "none" });
	});
});

describe("detectSpecReadyTransition", () => {
	const draft = specContent("draft");
	const ready = specContent("ready");

	test("write creating the SPEC as ready is a transition", () => {
		expect(detectSpecReadyTransition(null, "write", { content: ready })).toBe(true);
	});

	test("write flipping draft to ready is a transition", () => {
		expect(detectSpecReadyTransition(draft, "write", { content: ready })).toBe(true);
	});

	test("write keeping draft is not a transition", () => {
		expect(detectSpecReadyTransition(draft, "write", { content: draft })).toBe(false);
	});

	test("already-ready SPEC never triggers, even when rewritten as ready", () => {
		expect(detectSpecReadyTransition(ready, "write", { content: ready })).toBe(false);
		expect(detectSpecReadyTransition(ready, "edit", { edits: [{ oldText: "OAuth login", newText: "OAuth" }] })).toBe(
			false,
		);
	});

	test("quoted yaml status counts as ready", () => {
		const quoted = '---\ntitle: T\nstatus: "ready"\n---\n\n# SPEC\n';
		expect(detectSpecReadyTransition(draft, "write", { content: quoted })).toBe(true);
	});

	test("edit flipping status to ready is a transition", () => {
		expect(
			detectSpecReadyTransition(draft, "edit", { edits: [{ oldText: "status: draft", newText: "status: ready" }] }),
		).toBe(true);
	});

	test("edit accepts the legacy top-level oldText/newText shape", () => {
		expect(detectSpecReadyTransition(draft, "edit", { oldText: "status: draft", newText: "status: ready" })).toBe(
			true,
		);
	});

	test("edit not touching status is not a transition", () => {
		expect(detectSpecReadyTransition(draft, "edit", { edits: [{ oldText: "OAuth login", newText: "OAuth" }] })).toBe(
			false,
		);
	});

	test("unmatched oldText skips the gate", () => {
		expect(
			detectSpecReadyTransition(draft, "edit", { edits: [{ oldText: "does-not-exist", newText: "status: ready" }] }),
		).toBe(false);
	});

	test("edit against a missing SPEC skips the gate", () => {
		expect(
			detectSpecReadyTransition(null, "edit", { edits: [{ oldText: "status: draft", newText: "status: ready" }] }),
		).toBe(false);
	});

	test("invalid new frontmatter is not a transition", () => {
		expect(detectSpecReadyTransition(draft, "write", { content: "---\nstatus: [broken\n---\n" })).toBe(false);
		expect(detectSpecReadyTransition(draft, "write", { content: 42 })).toBe(false);
	});

	test("invalid current frontmatter still detects a ready write", () => {
		expect(detectSpecReadyTransition("---\nstatus: [broken\n---\n", "write", { content: ready })).toBe(true);
	});
});

describe("archiveBiuCycle", () => {
	const now = new Date("2026-08-01T12:00:00Z");

	async function seedCycle(): Promise<void> {
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await writeWorkspaceFile("Summary.md", "---\ntitle: Done\nhead_commit: def456\n---\n\n# Summary\n");
		await writeWorkspaceFile("tasks/TASK-a.md", taskContent("API", "completed"));
	}

	test("requires SPEC.md and Summary.md", async () => {
		await expect(archiveBiuCycle(cwd, "cycle", agentDir, now)).rejects.toThrow(/SPEC\.md does not exist/);
		await writeWorkspaceFile("SPEC.md", specContent("ready"));
		await expect(archiveBiuCycle(cwd, "cycle", agentDir, now)).rejects.toThrow(/Summary\.md does not exist/);
	});

	test("rejects shortnames that sanitize to nothing", async () => {
		await seedCycle();
		await expect(archiveBiuCycle(cwd, "///", agentDir, now)).rejects.toThrow(/empty after sanitization/);
	});

	test("moves the cycle into a dated archive directory and resets tasks/", async () => {
		await seedCycle();
		const paths = getBiuPaths(cwd, agentDir);
		const result = await archiveBiuCycle(cwd, "OAuth login", agentDir, now);

		expect(result.archiveName).toBe("2026-08-01-OAuth-login");
		expect(existsSync(join(result.archivedPath, "SPEC.md"))).toBe(true);
		expect(existsSync(join(result.archivedPath, "Summary.md"))).toBe(true);
		expect(existsSync(join(result.archivedPath, "tasks", "TASK-a.md"))).toBe(true);
		expect(existsSync(paths.specFile)).toBe(false);
		expect(existsSync(paths.summaryFile)).toBe(false);
		expect(await readdir(paths.tasksDir)).toEqual([]);

		const snapshot = await loadBiuSnapshot(cwd, agentDir);
		expect(snapshot.stage).toBe("plan");
	});

	test("suffixes duplicate archive names", async () => {
		await seedCycle();
		const first = await archiveBiuCycle(cwd, "cycle", agentDir, now);
		expect(first.archiveName).toBe("2026-08-01-cycle");
		await seedCycle();
		const second = await archiveBiuCycle(cwd, "cycle", agentDir, now);
		expect(second.archiveName).toBe("2026-08-01-cycle-02");
	});

	test("rolls back already-moved files when a move fails", async () => {
		await seedCycle();
		const paths = getBiuPaths(cwd, agentDir);
		let calls = 0;
		const failingMove = async (from: string, to: string): Promise<boolean> => {
			calls++;
			if (calls === 2) throw new Error("disk full");
			await rename(from, to);
			return true;
		};

		await expect(archiveBiuCycle(cwd, "cycle", agentDir, now, failingMove)).rejects.toThrow(/disk full/);
		expect(existsSync(paths.specFile)).toBe(true);
		expect(existsSync(paths.summaryFile)).toBe(true);
		expect(existsSync(join(paths.tasksDir, "TASK-a.md"))).toBe(true);
		expect(await readdir(paths.archivedDir)).toEqual([]);
	});
});
