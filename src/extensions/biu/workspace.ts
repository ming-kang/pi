/**
 * biu/workspace.ts — filesystem view of the Biu workspace.
 *
 * The workspace lives under <agentDir>/biu/<safe-cwd>/ and holds SPEC.md,
 * tasks/TASK-*.md, Summary.md, and archived/. Workflow state is carried by
 * Markdown frontmatter and derived on demand by loadBiuSnapshot(); nothing
 * here owns state. The model addresses workspace files through the biu://
 * scheme, resolved by resolveBiuUri().
 */
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { applyEditsToNormalizedContent, type Edit, normalizeToLF } from "../../core/tools/edit-diff.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { cwdToSafeDirName, resolvePath } from "../../utils/paths.ts";

export const BIU_URI_SCHEME = "biu://";
export const BIU_SPEC_FILE_NAME = "SPEC.md";
export const BIU_SUMMARY_FILE_NAME = "Summary.md";
export const BIU_TASKS_DIRECTORY_NAME = "tasks";
export const BIU_ARCHIVED_DIRECTORY_NAME = "archived";
export const BIU_MAX_SHORTNAME_LENGTH = 60;
/** Snapshot bound: tasks beyond this count are reported in problems, not listed. */
export const BIU_MAX_SNAPSHOT_TASKS = 100;

export const BIU_STAGES = ["plan", "execute", "archive"] as const;
export type BiuStage = (typeof BIU_STAGES)[number];

export const BIU_TASK_STATUSES = ["ready", "in_progress", "completed"] as const;
export type BiuTaskStatus = (typeof BIU_TASK_STATUSES)[number];

export const BIU_SPEC_STATUSES = ["draft", "ready"] as const;
export type BiuSpecStatus = (typeof BIU_SPEC_STATUSES)[number];

export const BIU_EXECUTION_MODES = ["direct", "tasks"] as const;
export type BiuExecutionMode = (typeof BIU_EXECUTION_MODES)[number];

export interface BiuPaths {
	root: string;
	specFile: string;
	summaryFile: string;
	tasksDir: string;
	archivedDir: string;
}

export function getBiuPaths(cwd: string, agentDir: string = getAgentDir()): BiuPaths {
	const root = join(agentDir, "biu", cwdToSafeDirName(resolvePath(cwd)));
	return {
		root,
		specFile: join(root, BIU_SPEC_FILE_NAME),
		summaryFile: join(root, BIU_SUMMARY_FILE_NAME),
		tasksDir: join(root, BIU_TASKS_DIRECTORY_NAME),
		archivedDir: join(root, BIU_ARCHIVED_DIRECTORY_NAME),
	};
}

/** Create the workspace directories when missing. Idempotent. */
export async function ensureBiuWorkspace(cwd: string, agentDir: string = getAgentDir()): Promise<BiuPaths> {
	const paths = getBiuPaths(cwd, agentDir);
	await Promise.all([mkdir(paths.tasksDir, { recursive: true }), mkdir(paths.archivedDir, { recursive: true })]);
	return paths;
}

export function isBiuUri(path: string): boolean {
	return path.startsWith(BIU_URI_SCHEME);
}

export type BiuUriResolution = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolve a biu:// URI to an absolute path inside the workspace for the given
 * cwd. `biu://` alone resolves to the workspace root. Rejects rooted rests and
 * any ".." segment, so a resolved path can never escape the workspace.
 */
export function resolveBiuUri(uri: string, cwd: string, agentDir: string = getAgentDir()): BiuUriResolution {
	if (!isBiuUri(uri)) return { ok: false, reason: `Not a biu:// path: ${uri}` };
	const rest = uri.slice(BIU_URI_SCHEME.length).replace(/\\/g, "/");
	if (rest.startsWith("/") || /^[A-Za-z]:/.test(rest) || rest.startsWith("~")) {
		return {
			ok: false,
			reason: `Invalid biu:// path ${JSON.stringify(uri)}: use a workspace-relative path like ${BIU_URI_SCHEME}${BIU_SPEC_FILE_NAME}.`,
		};
	}
	const segments = rest.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		return { ok: false, reason: `Invalid biu:// path ${JSON.stringify(uri)}: ".." segments are not allowed.` };
	}
	const paths = getBiuPaths(cwd, agentDir);
	return { ok: true, path: segments.length === 0 ? paths.root : join(paths.root, ...segments) };
}

/** Format a workspace-relative location as a biu:// URI for prompts and messages. */
export function toBiuUri(...segments: string[]): string {
	return `${BIU_URI_SCHEME}${segments.join("/")}`;
}

/** Whether the content's frontmatter says status: ready. Parse failures count as not ready. */
function isSpecContentReady(content: string): boolean {
	try {
		return parseFrontmatter(content).frontmatter.status === "ready";
	} catch {
		return false;
	}
}

/** Normalize edit-tool input into Edit[], accepting the legacy top-level oldText/newText shape. */
function toSpecEdits(input: Record<string, unknown>): Edit[] {
	const edits: Edit[] = [];
	if (Array.isArray(input.edits)) {
		for (const entry of input.edits) {
			if (!entry || typeof entry !== "object") continue;
			const candidate = entry as Record<string, unknown>;
			if (typeof candidate.oldText === "string" && typeof candidate.newText === "string") {
				edits.push({ oldText: candidate.oldText, newText: candidate.newText });
			}
		}
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		edits.push({ oldText: input.oldText, newText: input.newText });
	}
	return edits;
}

/**
 * Whether a write/edit tool call would flip the SPEC's frontmatter status from
 * non-ready to ready — the transition that requires user approval. Edits are
 * simulated with the edit tool's own replacement semantics. Any failure
 * (unmatched oldText, invalid YAML) returns false: the gate steps aside and
 * lets the real tool report the error.
 */
export function detectSpecReadyTransition(
	currentContent: string | null,
	toolName: "write" | "edit",
	input: Record<string, unknown>,
): boolean {
	if (currentContent !== null && isSpecContentReady(currentContent)) return false;
	if (toolName === "write") {
		return typeof input.content === "string" && isSpecContentReady(input.content);
	}
	if (currentContent === null) return false;
	const edits = toSpecEdits(input);
	if (edits.length === 0) return false;
	try {
		const { newContent } = applyEditsToNormalizedContent(normalizeToLF(currentContent), edits, BIU_SPEC_FILE_NAME);
		return isSpecContentReady(newContent);
	} catch {
		return false;
	}
}

export interface BiuSpecInfo {
	exists: boolean;
	/** "unknown" when the file exists but frontmatter is missing or invalid. */
	status: BiuSpecStatus | "unknown";
	title: string | null;
	baselineCommit: string | null;
	/** Execution path chosen in the plan stage; null when absent or invalid. */
	execution: BiuExecutionMode | null;
}

export interface BiuTaskInfo {
	/** Task id = file name without the .md extension, e.g. "TASK-alias". */
	id: string;
	title: string;
	/** "unknown" when frontmatter is missing or invalid; treated as neither ready nor completed. */
	status: BiuTaskStatus | "unknown";
	dependsOn: string[];
}

export interface BiuTaskCounts {
	total: number;
	ready: number;
	inProgress: number;
	completed: number;
	unknown: number;
}

export type BiuFocus =
	| { kind: "active"; task: BiuTaskInfo }
	| { kind: "next"; task: BiuTaskInfo }
	| { kind: "allDone" }
	| { kind: "none" };

export interface BiuSnapshot {
	stage: BiuStage;
	spec: BiuSpecInfo;
	summaryExists: boolean;
	tasks: BiuTaskInfo[];
	counts: BiuTaskCounts;
	focus: BiuFocus;
	/** Human-readable notes about unreadable or malformed workspace files. */
	problems: string[];
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function asTrimmedString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function parseStatus<T extends string>(value: unknown, allowed: readonly T[]): T | "unknown" {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : "unknown";
}

/** Strip an optional .md extension so depends_on accepts "TASK-x" and "TASK-x.md" alike. */
function toTaskId(reference: string): string {
	return reference.endsWith(".md") ? reference.slice(0, -3) : reference;
}

async function readSpecInfo(specFile: string, problems: string[]): Promise<BiuSpecInfo> {
	let raw: string;
	try {
		raw = await readFile(specFile, "utf8");
	} catch (error) {
		if (!isMissingFileError(error)) problems.push(`${BIU_SPEC_FILE_NAME}: ${describeError(error)}`);
		return { exists: false, status: "unknown", title: null, baselineCommit: null, execution: null };
	}
	try {
		const { frontmatter } = parseFrontmatter(raw);
		const status = parseStatus(frontmatter.status, BIU_SPEC_STATUSES);
		if (status === "unknown") {
			problems.push(`${BIU_SPEC_FILE_NAME}: frontmatter "status" must be one of ${BIU_SPEC_STATUSES.join(", ")}.`);
		}
		let execution: BiuExecutionMode | null = null;
		if (frontmatter.execution !== undefined) {
			const parsed = parseStatus(frontmatter.execution, BIU_EXECUTION_MODES);
			if (parsed === "unknown") {
				problems.push(
					`${BIU_SPEC_FILE_NAME}: frontmatter "execution" must be one of ${BIU_EXECUTION_MODES.join(", ")}.`,
				);
			} else {
				execution = parsed;
			}
		}
		return {
			exists: true,
			status,
			title: asTrimmedString(frontmatter.title),
			baselineCommit: asTrimmedString(frontmatter.baseline_commit),
			execution,
		};
	} catch (error) {
		problems.push(`${BIU_SPEC_FILE_NAME}: invalid frontmatter (${describeError(error)})`);
		return { exists: true, status: "unknown", title: null, baselineCommit: null, execution: null };
	}
}

async function readTaskInfo(tasksDir: string, fileName: string, problems: string[]): Promise<BiuTaskInfo> {
	const id = toTaskId(fileName);
	const relative = `${BIU_TASKS_DIRECTORY_NAME}/${fileName}`;
	let raw: string;
	try {
		raw = await readFile(join(tasksDir, fileName), "utf8");
	} catch (error) {
		problems.push(`${relative}: ${describeError(error)}`);
		return { id, title: id, status: "unknown", dependsOn: [] };
	}
	try {
		const { frontmatter } = parseFrontmatter(raw);
		const status = parseStatus(frontmatter.status, BIU_TASK_STATUSES);
		if (status === "unknown") {
			problems.push(`${relative}: frontmatter "status" must be one of ${BIU_TASK_STATUSES.join(", ")}.`);
		}
		const dependsOn = Array.isArray(frontmatter.depends_on)
			? frontmatter.depends_on.filter((dep): dep is string => typeof dep === "string").map(toTaskId)
			: [];
		return { id, title: asTrimmedString(frontmatter.title) ?? id, status, dependsOn };
	} catch (error) {
		problems.push(`${relative}: invalid frontmatter (${describeError(error)})`);
		return { id, title: id, status: "unknown", dependsOn: [] };
	}
}

function countTasks(tasks: BiuTaskInfo[]): BiuTaskCounts {
	const counts: BiuTaskCounts = { total: tasks.length, ready: 0, inProgress: 0, completed: 0, unknown: 0 };
	for (const task of tasks) {
		if (task.status === "ready") counts.ready++;
		else if (task.status === "in_progress") counts.inProgress++;
		else if (task.status === "completed") counts.completed++;
		else counts.unknown++;
	}
	return counts;
}

/** What to work on next: the in-progress task, else the first ready task whose dependencies are all completed. */
export function getBiuFocus(tasks: BiuTaskInfo[]): BiuFocus {
	const active = tasks.find((task) => task.status === "in_progress");
	if (active) return { kind: "active", task: active };
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const next = tasks.find(
		(task) => task.status === "ready" && task.dependsOn.every((dep) => byId.get(dep)?.status === "completed"),
	);
	if (next) return { kind: "next", task: next };
	if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) return { kind: "allDone" };
	return { kind: "none" };
}

function deriveStage(spec: BiuSpecInfo, tasks: BiuTaskInfo[], summaryExists: boolean): BiuStage {
	if (summaryExists) return "archive";
	if (!spec.exists || spec.status !== "ready") return "plan";
	if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) return "archive";
	return "execute";
}

/**
 * Build the workspace snapshot by reading frontmatter from SPEC.md and
 * tasks/*.md. Content problems (unreadable files, malformed frontmatter) are
 * reported in `problems` and degrade to "unknown" instead of throwing.
 */
export async function loadBiuSnapshot(cwd: string, agentDir: string = getAgentDir()): Promise<BiuSnapshot> {
	const paths = getBiuPaths(cwd, agentDir);
	const problems: string[] = [];

	const spec = await readSpecInfo(paths.specFile, problems);

	let summaryExists = false;
	try {
		summaryExists = await pathExists(paths.summaryFile);
	} catch (error) {
		problems.push(`${BIU_SUMMARY_FILE_NAME}: ${describeError(error)}`);
	}

	let taskFiles: string[] = [];
	try {
		taskFiles = (await readdir(paths.tasksDir)).filter((name) => name.endsWith(".md")).sort();
	} catch (error) {
		if (!isMissingFileError(error)) problems.push(`${BIU_TASKS_DIRECTORY_NAME}/: ${describeError(error)}`);
	}
	if (taskFiles.length > BIU_MAX_SNAPSHOT_TASKS) {
		problems.push(
			`${BIU_TASKS_DIRECTORY_NAME}/: ${taskFiles.length} task files exceed the snapshot limit of ${BIU_MAX_SNAPSHOT_TASKS}; only the first ${BIU_MAX_SNAPSHOT_TASKS} are listed.`,
		);
		taskFiles = taskFiles.slice(0, BIU_MAX_SNAPSHOT_TASKS);
	}
	const tasks: BiuTaskInfo[] = [];
	for (const fileName of taskFiles) {
		tasks.push(await readTaskInfo(paths.tasksDir, fileName, problems));
	}

	return {
		stage: deriveStage(spec, tasks, summaryExists),
		spec,
		summaryExists,
		tasks,
		counts: countTasks(tasks),
		focus: getBiuFocus(tasks),
		problems,
	};
}

export function sanitizeShortname(shortname: string): string {
	const printable = Array.from(shortname.trim())
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("");
	const cleaned = printable
		.replace(/[<>:"/\\|?*]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return cleaned.slice(0, BIU_MAX_SHORTNAME_LENGTH).replace(/^[-.]+|[-.]+$/g, "");
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
}

/**
 * Close the current cycle: move SPEC.md, Summary.md, and tasks/ into
 * archived/YYYY-MM-DD-<shortname>/. If any move fails, already-moved files are
 * rolled back so the cycle is never left half-archived; when a rollback itself
 * fails, the recovery data stays in the archive directory and the error says
 * where. Requires SPEC.md and Summary.md to exist so an empty or unfinished
 * draft is never archived silently.
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
	try {
		for (const entry of moves) {
			if (await move(entry.from, entry.to)) moved.push(entry);
		}
	} catch (error) {
		throw await rollbackArchive(error, archivedPath, moved);
	}
	// Recreate the empty tasks/ directory for the next cycle. Best-effort: the
	// next ensureBiuWorkspace call recreates it anyway.
	await mkdir(paths.tasksDir, { recursive: true }).catch(() => {});
	return { archivedPath, archiveName };
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
