import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { analyzeBiuWorkspace, type BiuSourceDocument, type BiuTaskStatus } from "../src/extensions/biu/stage.ts";
import {
	BIU_MAX_DOCUMENT_BYTES,
	BIU_MAX_TASK_FILES,
	ensureBiuWorkspace,
	getBiuProjectDirectory,
	getBiuWorkspacePaths,
	scanBiuWorkspace,
} from "../src/extensions/biu/storage.ts";
import { cwdToSafeDirName, resolvePath } from "../src/utils/paths.ts";

function spec(
	status: "draft" | "ready" = "ready",
	options: { title?: string; openQuestions?: string; acceptanceCriteria?: string[] } = {},
): BiuSourceDocument {
	const title = options.title === undefined ? "Ship feature" : options.title;
	const openQuestions = options.openQuestions === undefined ? "- [x] Scope confirmed" : options.openQuestions;
	const acceptanceCriteria = options.acceptanceCriteria ?? ["AC1: Works"];
	return {
		path: "/biu/SPEC.md",
		content: `---\ntitle: ${title}\nstatus: ${status}\n---\n\n## Open Questions\n${openQuestions}\n\n## Acceptance Criteria\n${acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}\n`,
	};
}

function task(
	id: string,
	options: { status?: BiuTaskStatus; dependsOn?: string[]; covers?: string[]; fileName?: string } = {},
): BiuSourceDocument {
	const status = options.status ?? "ready";
	const dependsOn = options.dependsOn ?? [];
	const covers = options.covers ?? ["AC1"];
	return {
		path: `/biu/tasks/${options.fileName ?? `${id}.md`}`,
		content: `---\nid: ${id}\ntitle: ${id} title\nstatus: ${status}\ndepends_on: [${dependsOn.join(", ")}]\n---\n\n## Covers\n${covers.map((criterion) => `- ${criterion}`).join("\n")}\n`,
	};
}

function analyze(options: {
	spec?: BiuSourceDocument;
	tasks?: BiuSourceDocument[];
	summaryExists?: boolean;
	issues?: string[];
}) {
	return analyzeBiuWorkspace({
		tasks: [],
		summaryExists: false,
		...options,
	});
}

describe("Biu stage inference", () => {
	test("starts with interview and keeps a valid draft there", () => {
		expect(analyze({}).stage).toBe("interview");
		const draft = analyze({ spec: spec("draft") });
		expect(draft.stage).toBe("interview");
		expect(draft.specStatus).toBe("draft");
	});

	test("moves a ready SPEC through decompose, execute, and archive", () => {
		const readySpec = spec("ready", { acceptanceCriteria: ["AC1: First", "AC2: Second"] });
		const empty = analyze({ spec: readySpec });
		expect(empty.stage).toBe("decompose");

		const partial = analyze({ spec: readySpec, tasks: [task("TASK-a", { covers: ["AC1"] })] });
		expect(partial.stage).toBe("decompose");
		expect(partial.missingAcceptanceCriteria).toEqual(["AC2"]);

		const executable = analyze({
			spec: readySpec,
			tasks: [task("TASK-a", { covers: ["AC1"] }), task("TASK-b", { dependsOn: ["TASK-a"], covers: ["AC2"] })],
		});
		expect(executable.stage).toBe("execute");
		expect(executable.nextTask?.id).toBe("TASK-a");
		expect(executable.taskCounts).toEqual({ total: 2, ready: 2, inProgress: 0, completed: 0 });

		const active = analyze({
			spec: readySpec,
			tasks: [
				task("TASK-a", { status: "completed", covers: ["AC1"] }),
				task("TASK-b", { status: "in_progress", dependsOn: ["TASK-a"], covers: ["AC2"] }),
			],
		});
		expect(active.stage).toBe("execute");
		expect(active.activeTask?.id).toBe("TASK-b");
		expect(active.nextTask).toBeUndefined();

		const complete = analyze({
			spec: readySpec,
			tasks: [
				task("TASK-a", { status: "completed", covers: ["AC1"] }),
				task("TASK-b", { status: "completed", dependsOn: ["TASK-a"], covers: ["AC2"] }),
			],
		});
		expect(complete.stage).toBe("archive");
	});

	test("parses checkbox AC definitions without treating prose references as duplicates", () => {
		const document = spec();
		document.content = document.content
			.replace("## Acceptance Criteria", "##  Acceptance Criteria\nFor context, AC1: remains stable.")
			.replace("- [ ] AC1: Works", "- [x] AC1: Works");
		const result = analyze({ spec: document });
		expect(result.stage).toBe("decompose");
		expect(result.acceptanceCriteria).toEqual(["AC1"]);
		expect(result.issues).toEqual([]);
	});

	test("treats a root Summary.md as archive review in progress", () => {
		const result = analyze({ spec: spec(), tasks: [task("TASK-a")], summaryExists: true });
		expect(result.stage).toBe("archive");
		expect(result.taskCounts.ready).toBe(1);
	});

	test("uses stable task-id order to select the next unblocked task", () => {
		const result = analyze({
			spec: spec(),
			tasks: [task("TASK-z"), task("TASK-a"), task("TASK-m", { dependsOn: ["TASK-z"] })],
		});
		expect(result.tasks.map((candidate) => candidate.id)).toEqual(["TASK-a", "TASK-m", "TASK-z"]);
		expect(result.nextTask?.id).toBe("TASK-a");
	});
});

describe("Biu repair detection", () => {
	test.each([
		{
			name: "unresolved ready-SPEC questions",
			value: () => analyze({ spec: spec("ready", { openQuestions: "- [ ]" }) }),
			issue: /unresolved open questions/,
		},
		{
			name: "a missing ready-SPEC title",
			value: () => analyze({ spec: spec("ready", { title: "" }) }),
			issue: /must have a title/,
		},
		{
			name: "tasks without a SPEC",
			value: () => analyze({ tasks: [task("TASK-a")] }),
			issue: /tasks exist without SPEC/,
		},
		{
			name: "an unknown dependency",
			value: () => analyze({ spec: spec(), tasks: [task("TASK-a", { dependsOn: ["TASK-missing"] })] }),
			issue: /does not exist/,
		},
		{
			name: "a dependency cycle",
			value: () =>
				analyze({
					spec: spec(),
					tasks: [task("TASK-a", { dependsOn: ["TASK-b"] }), task("TASK-b", { dependsOn: ["TASK-a"] })],
				}),
			issue: /contains a cycle/,
		},
		{
			name: "multiple active tasks",
			value: () =>
				analyze({
					spec: spec(),
					tasks: [task("TASK-a", { status: "in_progress" }), task("TASK-b", { status: "in_progress" })],
				}),
			issue: /multiple tasks are in_progress/,
		},
		{
			name: "unknown AC coverage",
			value: () => analyze({ spec: spec(), tasks: [task("TASK-a", { covers: ["AC2"] })] }),
			issue: /unknown AC2/,
		},
		{
			name: "an active task with an incomplete dependency",
			value: () =>
				analyze({
					spec: spec(),
					tasks: [task("TASK-a"), task("TASK-b", { status: "in_progress", dependsOn: ["TASK-a"] })],
				}),
			issue: /depends on incomplete TASK-a/,
		},
		{
			name: "a non-portable task id",
			value: () => analyze({ spec: spec(), tasks: [task("TASK-bad/id", { fileName: "TASK-bad-id.md" })] }),
			issue: /portable TASK-\* value/,
		},
		{
			name: "a filename/id mismatch",
			value: () => analyze({ spec: spec(), tasks: [task("TASK-a", { fileName: "TASK-other.md" })] }),
			issue: /filename must match task id/,
		},
	])("enters repair for $name", ({ value, issue }) => {
		const result = value();
		expect(result.stage).toBe("repair");
		expect(result.issues.join("\n")).toMatch(issue);
	});

	test("partial AC coverage becomes repair after execution starts", () => {
		const result = analyze({
			spec: spec("ready", { acceptanceCriteria: ["AC1: First", "AC2: Second"] }),
			tasks: [task("TASK-a", { status: "in_progress", covers: ["AC1"] })],
		});
		expect(result.stage).toBe("repair");
		expect(result.missingAcceptanceCriteria).toEqual(["AC2"]);
		expect(result.issues.join("\n")).toContain("started execution before covering AC2");
	});
});

describe("Biu storage", () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
	});

	async function temporaryRoot(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "pi-biu-stage-"));
		temporaryRoots.push(root);
		return root;
	}

	test("uses session-style cwd encoding under the agent directory", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const expected = join(agentDir, "biu", cwdToSafeDirName(resolvePath(cwd)));
		expect(getBiuProjectDirectory(cwd, agentDir)).toBe(expected);
		expect(getBiuWorkspacePaths(cwd, agentDir).root).toBe(expected);
	});

	test("creates only the private workspace and ignores a project-local .biu directory", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(join(cwd, ".biu"), { recursive: true });
		await writeFile(join(cwd, ".biu", "SPEC.md"), spec().content, "utf8");

		const paths = await ensureBiuWorkspace(cwd, agentDir);
		expect(existsSync(paths.tasks)).toBe(true);
		expect(existsSync(paths.archived)).toBe(true);
		expect(existsSync(paths.spec)).toBe(false);
		expect(existsSync(join(cwd, ".biu", "SPEC.md"))).toBe(true);
		expect((await scanBiuWorkspace(cwd, agentDir)).stage).toBe("interview");
	});

	test("scans bounded active artifacts and does not descend into archives", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const paths = await ensureBiuWorkspace(cwd, agentDir);
		await writeFile(paths.spec, spec().content, "utf8");
		await writeFile(join(paths.tasks, "TASK-active.md"), task("TASK-active").content, "utf8");
		await mkdir(join(paths.archived, "2026-01-01-01", "tasks"), { recursive: true });
		await writeFile(
			join(paths.archived, "2026-01-01-01", "tasks", "TASK-archived.md"),
			task("TASK-archived").content,
			"utf8",
		);
		await writeFile(join(paths.tasks, "notes.md"), "not a task", "utf8");

		const snapshot = await scanBiuWorkspace(cwd, agentDir);
		expect(snapshot.stage).toBe("execute");
		expect(snapshot.tasks.map((candidate) => candidate.id)).toEqual(["TASK-active"]);
	});

	test("rejects oversized artifacts without injecting their content", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const paths = await ensureBiuWorkspace(cwd, agentDir);
		await writeFile(paths.spec, "x".repeat(BIU_MAX_DOCUMENT_BYTES + 1), "utf8");

		const snapshot = await scanBiuWorkspace(cwd, agentDir);
		expect(snapshot.stage).toBe("repair");
		expect(snapshot.issues.join("\n")).toContain(`exceeds ${BIU_MAX_DOCUMENT_BYTES} bytes`);
	});

	test("caps the number of active task files", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const paths = await ensureBiuWorkspace(cwd, agentDir);
		await writeFile(paths.spec, spec().content, "utf8");
		await Promise.all(
			Array.from({ length: BIU_MAX_TASK_FILES + 1 }, async (_, index) => {
				const id = `TASK-${String(index).padStart(3, "0")}`;
				await writeFile(join(paths.tasks, `${id}.md`), task(id).content, "utf8");
			}),
		);

		const snapshot = await scanBiuWorkspace(cwd, agentDir);
		expect(snapshot.tasks).toHaveLength(BIU_MAX_TASK_FILES);
		expect(snapshot.stage).toBe("repair");
		expect(snapshot.issues.join("\n")).toContain(
			`contains ${BIU_MAX_TASK_FILES + 1} task files; maximum is ${BIU_MAX_TASK_FILES}`,
		);
	});
});
