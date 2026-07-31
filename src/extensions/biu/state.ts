/**
 * biu/state.ts — the biu.json state machine.
 *
 * biu.json is the single source of truth for workflow state (stage, spec
 * readiness, task statuses, dependencies). Markdown files under the same
 * workspace carry content only and are never parsed for state. All writes go
 * through saveBiuState(), which writes atomically (tmp + rename).
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { cwdToSafeDirName, resolvePath } from "../../utils/paths.ts";

export const BIU_STATE_FILE_NAME = "biu.json";
export const BIU_SPEC_FILE_NAME = "SPEC.md";
export const BIU_SUMMARY_FILE_NAME = "Summary.md";
export const BIU_TASKS_DIRECTORY_NAME = "tasks";
export const BIU_ARCHIVED_DIRECTORY_NAME = "archived";
export const BIU_STATE_VERSION = 1;
export const BIU_MAX_TASKS = 200;
export const BIU_MAX_TITLE_LENGTH = 200;
export const BIU_MAX_SHORTNAME_LENGTH = 60;

export const BIU_STAGES = ["interview", "decompose", "execute", "archive"] as const;
export type BiuStage = (typeof BIU_STAGES)[number];

export const BIU_TASK_STATUSES = ["ready", "in_progress", "completed"] as const;
export type BiuTaskStatus = (typeof BIU_TASK_STATUSES)[number];

export const BIU_SPEC_STATUSES = ["draft", "ready"] as const;
export type BiuSpecStatus = (typeof BIU_SPEC_STATUSES)[number];

const TASK_ID_PATTERN = /^TASK-[A-Za-z0-9._-]{1,80}$/;

export interface BiuTask {
	id: string;
	title: string;
	status: BiuTaskStatus;
	dependsOn: string[];
}

export interface BiuSpecState {
	status: BiuSpecStatus;
	title: string | null;
	baselineCommit: string | null;
}

export interface BiuState {
	version: typeof BIU_STATE_VERSION;
	stage: BiuStage;
	spec: BiuSpecState;
	tasks: BiuTask[];
	createdAt: string;
	updatedAt: string;
}

export interface BiuPaths {
	root: string;
	stateFile: string;
	specFile: string;
	summaryFile: string;
	tasksDir: string;
	archivedDir: string;
}

export interface BiuTaskCounts {
	total: number;
	ready: number;
	inProgress: number;
	completed: number;
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function getBiuPaths(cwd: string, agentDir: string = getAgentDir()): BiuPaths {
	const root = join(agentDir, "biu", cwdToSafeDirName(resolvePath(cwd)));
	return {
		root,
		stateFile: join(root, BIU_STATE_FILE_NAME),
		specFile: join(root, BIU_SPEC_FILE_NAME),
		summaryFile: join(root, BIU_SUMMARY_FILE_NAME),
		tasksDir: join(root, BIU_TASKS_DIRECTORY_NAME),
		archivedDir: join(root, BIU_ARCHIVED_DIRECTORY_NAME),
	};
}

export function createInitialBiuState(now: Date = new Date()): BiuState {
	const timestamp = now.toISOString();
	return {
		version: BIU_STATE_VERSION,
		stage: "interview",
		spec: { status: "draft", title: null, baselineCommit: null },
		tasks: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function isValidTaskId(id: string): boolean {
	return TASK_ID_PATTERN.test(id);
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label}: expected a string`);
	return value;
}

function assertNullableString(value: unknown, label: string): string | null {
	if (value === null) return null;
	return assertString(value, label);
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new Error(`${label}: expected one of ${allowed.join(", ")}`);
	}
	return value as T;
}

/** Validate an untrusted value as BiuState. Throws with a specific message on any contract violation. */
export function validateBiuState(value: unknown): BiuState {
	if (!value || typeof value !== "object") throw new Error("biu.json: expected an object");
	const record = value as Record<string, unknown>;
	if (record.version !== BIU_STATE_VERSION) {
		throw new Error(`biu.json: unsupported version ${String(record.version)} (expected ${BIU_STATE_VERSION})`);
	}
	const stage = assertOneOf(record.stage, BIU_STAGES, "biu.json stage");

	if (!record.spec || typeof record.spec !== "object") throw new Error("biu.json spec: expected an object");
	const specRecord = record.spec as Record<string, unknown>;
	const spec: BiuSpecState = {
		status: assertOneOf(specRecord.status, BIU_SPEC_STATUSES, "biu.json spec.status"),
		title: assertNullableString(specRecord.title, "biu.json spec.title"),
		baselineCommit: assertNullableString(specRecord.baselineCommit, "biu.json spec.baselineCommit"),
	};

	if (!Array.isArray(record.tasks)) throw new Error("biu.json tasks: expected an array");
	if (record.tasks.length > BIU_MAX_TASKS) {
		throw new Error(`biu.json tasks: ${record.tasks.length} entries exceed the maximum of ${BIU_MAX_TASKS}`);
	}
	const seen = new Set<string>();
	const tasks: BiuTask[] = record.tasks.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`biu.json tasks[${index}]: expected an object`);
		const taskRecord = entry as Record<string, unknown>;
		const id = assertString(taskRecord.id, `biu.json tasks[${index}].id`);
		if (!isValidTaskId(id)) throw new Error(`biu.json tasks[${index}].id: invalid task id ${JSON.stringify(id)}`);
		if (seen.has(id)) throw new Error(`biu.json tasks: duplicate task id ${JSON.stringify(id)}`);
		seen.add(id);
		if (!Array.isArray(taskRecord.dependsOn))
			throw new Error(`biu.json tasks[${index}].dependsOn: expected an array`);
		return {
			id,
			title: assertString(taskRecord.title, `biu.json tasks[${index}].title`),
			status: assertOneOf(taskRecord.status, BIU_TASK_STATUSES, `biu.json tasks[${index}].status`),
			dependsOn: taskRecord.dependsOn.map((dep, depIndex) =>
				assertString(dep, `biu.json tasks[${index}].dependsOn[${depIndex}]`),
			),
		};
	});
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (!seen.has(dep)) {
				throw new Error(`biu.json tasks: ${task.id} depends on unknown task ${JSON.stringify(dep)}`);
			}
		}
	}
	for (const task of tasks) {
		if (task.dependsOn.includes(task.id)) {
			throw new Error(`biu.json tasks: ${task.id} depends on itself`);
		}
	}
	const cycleNode = findCycleNode(tasks);
	if (cycleNode) {
		throw new Error(`biu.json tasks: dependency cycle involving ${JSON.stringify(cycleNode)}`);
	}

	return {
		version: BIU_STATE_VERSION,
		stage,
		spec,
		tasks,
		createdAt: assertString(record.createdAt, "biu.json createdAt"),
		updatedAt: assertString(record.updatedAt, "biu.json updatedAt"),
	};
}

/** Load biu.json. Returns undefined when the file does not exist; throws when it is unreadable or invalid. */
export async function loadBiuState(cwd: string, agentDir: string = getAgentDir()): Promise<BiuState | undefined> {
	const paths = getBiuPaths(cwd, agentDir);
	let raw: string;
	try {
		raw = await readFile(paths.stateFile, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${paths.stateFile}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	return validateBiuState(parsed);
}

/** Persist biu.json atomically: write to a temp file in the same directory, then rename over the target. */
export async function saveBiuState(cwd: string, state: BiuState, agentDir: string = getAgentDir()): Promise<void> {
	const paths = getBiuPaths(cwd, agentDir);
	await mkdir(paths.root, { recursive: true });
	const tempFile = `${paths.stateFile}.${process.pid}.tmp`;
	await writeFile(tempFile, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	try {
		await rename(tempFile, paths.stateFile);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Create workspace directories and biu.json when missing. Returns the current
 * state. Refuses to create a fresh state when biu.json is missing but cycle
 * files are still present, so a deleted state file never leads to silently
 * overwriting leftover SPEC.md or task files.
 */
export async function ensureBiuWorkspace(
	cwd: string,
	agentDir: string = getAgentDir(),
): Promise<{ paths: BiuPaths; state: BiuState; created: boolean }> {
	const paths = getBiuPaths(cwd, agentDir);
	await Promise.all([mkdir(paths.tasksDir, { recursive: true }), mkdir(paths.archivedDir, { recursive: true })]);
	const existing = await loadBiuState(cwd, agentDir);
	if (existing) return { paths, state: existing, created: false };
	if (await pathExists(paths.specFile)) {
		throw new Error(
			`biu.json is missing but ${paths.specFile} still exists. Restore biu.json from a backup, or remove or archive the leftover cycle files before starting a new cycle.`,
		);
	}
	const state = createInitialBiuState();
	await saveBiuState(cwd, state, agentDir);
	return { paths, state, created: true };
}

export function getTaskCounts(state: BiuState): BiuTaskCounts {
	const counts: BiuTaskCounts = { total: state.tasks.length, ready: 0, inProgress: 0, completed: 0 };
	for (const task of state.tasks) {
		if (task.status === "ready") counts.ready++;
		else if (task.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}

export function findActiveTask(state: BiuState): BiuTask | undefined {
	return state.tasks.find((task) => task.status === "in_progress");
}

/** First ready task whose dependencies are all completed, in declaration order. */
export function findNextTask(state: BiuState): BiuTask | undefined {
	const byId = new Map(state.tasks.map((task) => [task.id, task]));
	return state.tasks.find(
		(task) => task.status === "ready" && task.dependsOn.every((dep) => byId.get(dep)?.status === "completed"),
	);
}

/**
 * Find a task participating in a dependency cycle, or undefined when the
 * graph is acyclic. `override` replaces one task's edges with a candidate
 * set, for cycle checks on proposed writes; `start` limits the walk to the
 * given task and its reachable subgraph (matching the old wouldCreateCycle
 * semantics), while omitting it walks the whole graph.
 */
export function findCycleNode(
	tasks: BiuTask[],
	override?: { id: string; dependsOn: string[] },
	start?: string,
): string | undefined {
	const edges = new Map<string, string[]>(tasks.map((task) => [task.id, task.dependsOn]));
	if (override) edges.set(override.id, override.dependsOn);
	const visiting = new Set<string>();
	const done = new Set<string>();
	const visit = (id: string): string | undefined => {
		if (done.has(id)) return undefined;
		if (visiting.has(id)) return id;
		visiting.add(id);
		for (const dep of edges.get(id) ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		visiting.delete(id);
		done.add(id);
		return undefined;
	};
	const starts = start !== undefined ? [start] : tasks.map((task) => task.id);
	for (const id of starts) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}

/**
 * Check whether assigning `dependsOn` to `taskId` would create a dependency
 * cycle, using the other tasks' current edges.
 */
export function wouldCreateCycle(tasks: BiuTask[], taskId: string, dependsOn: string[]): boolean {
	return findCycleNode(tasks, { id: taskId, dependsOn }, taskId) !== undefined;
}

/**
 * Forward-validation for stage transitions. Returns an error message when the
 * transition is not allowed, undefined when it is. Backward moves are always
 * allowed; the destructive step (archive) is gated separately in the tool.
 */
export function getStageTransitionError(state: BiuState, to: BiuStage): string | undefined {
	if (to === state.stage) return `Already in the ${to} stage.`;
	if (to === "decompose" && state.spec.status !== "ready") {
		return 'Cannot enter decompose: the SPEC is not ready. Finish the interview and mark it ready first (biu action "spec" with specStatus "ready", after explicit user approval).';
	}
	if (to === "execute" && state.tasks.length === 0) {
		return 'Cannot enter execute: no tasks are registered. Decompose the SPEC into tasks first (biu action "task").';
	}
	return undefined;
}

function sanitizeShortname(shortname: string): string {
	const cleaned = shortname
		.trim()
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return cleaned.slice(0, BIU_MAX_SHORTNAME_LENGTH).replace(/^[-.]+|[-.]+$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

/** Signature for archive file moves; injectable for tests. */
export type BiuMoveFile = (from: string, to: string) => Promise<boolean>;

/** Move one file or directory, returning false when the source does not exist. */
async function moveIfExists(from: string, to: string): Promise<boolean> {
	if (!(await pathExists(from))) return false;
	await rename(from, to);
	return true;
}

export interface BiuArchiveResult {
	archivedPath: string;
	archiveName: string;
	state: BiuState;
}

/**
 * Close the current cycle: move SPEC.md, Summary.md, and tasks/ into
 * archived/YYYY-MM-DD-<shortname>/ and reset biu.json to a fresh cycle. If
 * any move or the state reset fails, already-moved files are rolled back so
 * the cycle is never left half-archived; when a rollback itself fails, the
 * recovery data stays in the archive directory and the error says where.
 * Requires SPEC.md and Summary.md to exist so an empty or unfinished draft
 * is never archived silently.
 *
 * `move` is injectable for tests; rollback always uses the real move.
 */
export async function archiveBiuCycle(
	cwd: string,
	shortname: string,
	agentDir: string = getAgentDir(),
	now: Date = new Date(),
	move: BiuMoveFile = moveIfExists,
): Promise<BiuArchiveResult> {
	const paths = getBiuPaths(cwd, agentDir);
	const safeName = sanitizeShortname(shortname);
	if (!safeName) throw new Error(`Archive shortname ${JSON.stringify(shortname)} is empty after sanitization.`);
	if (!(await pathExists(paths.specFile))) {
		throw new Error("Cannot archive: SPEC.md does not exist in the Biu workspace.");
	}
	if (!(await pathExists(paths.summaryFile))) {
		throw new Error("Cannot archive: Summary.md does not exist yet. Draft and confirm the summary first.");
	}

	await mkdir(paths.archivedDir, { recursive: true });
	const date = now.toISOString().slice(0, 10);
	const baseName = `${date}-${safeName}`;
	let existing: string[];
	try {
		existing = await readdir(paths.archivedDir);
	} catch {
		existing = [];
	}
	let archiveName = baseName;
	for (let suffix = 2; existing.includes(archiveName); suffix++) {
		archiveName = `${baseName}-${String(suffix).padStart(2, "0")}`;
	}
	const archivedPath = join(paths.archivedDir, archiveName);
	await mkdir(archivedPath, { recursive: false });

	const moves: Array<{ from: string; to: string }> = [
		{ from: paths.specFile, to: join(archivedPath, BIU_SPEC_FILE_NAME) },
		{ from: paths.summaryFile, to: join(archivedPath, BIU_SUMMARY_FILE_NAME) },
		{ from: paths.tasksDir, to: join(archivedPath, BIU_TASKS_DIRECTORY_NAME) },
	];
	const moved: Array<{ from: string; to: string }> = [];
	let state: BiuState;
	try {
		for (const entry of moves) {
			if (await move(entry.from, entry.to)) moved.push(entry);
		}
		state = createInitialBiuState(now);
		await saveBiuState(cwd, state, agentDir);
	} catch (error) {
		throw await rollbackArchive(error, archivedPath, moved);
	}
	// Recreate the empty tasks/ directory for the fresh cycle. Best-effort and
	// deliberately outside the rollback scope: the state is already reset, so
	// rolling back here would contradict it, and the next ensureBiuWorkspace
	// call recreates the directory anyway.
	await mkdir(paths.tasksDir, { recursive: true }).catch(() => {});
	return { archivedPath, archiveName, state };
}

/**
 * Reverse the already-moved files and clean the archive directory. Returns
 * the original error unchanged when the rollback fully succeeded, otherwise
 * a chained error whose message says exactly what remains inconsistent.
 */
async function rollbackArchive(
	error: unknown,
	archivedPath: string,
	moved: Array<{ from: string; to: string }>,
): Promise<Error> {
	const restoreErrors: string[] = [];
	for (const entry of [...moved].reverse()) {
		try {
			await moveIfExists(entry.to, entry.from);
		} catch (restoreError) {
			restoreErrors.push(`moving ${entry.to} back failed: ${describeError(restoreError)}`);
		}
	}
	if (restoreErrors.length > 0) {
		return new Error(
			`${describeError(error)} Rollback incomplete, recovery data left in ${archivedPath}: ${restoreErrors.join("; ")}`,
			{ cause: error },
		);
	}
	try {
		await rm(archivedPath, { recursive: true, force: true });
	} catch (cleanupError) {
		return new Error(
			`${describeError(error)} Rollback succeeded, but removing the empty ${archivedPath} directory failed: ${describeError(cleanupError)}`,
			{ cause: error },
		);
	}
	return error instanceof Error ? error : new Error(describeError(error), { cause: error });
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
