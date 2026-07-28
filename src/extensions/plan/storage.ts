/**
 * plan/storage.ts — plan file layout and writing.
 *
 * Plans live under `<agentDir>/plans/<safeCwdDir>/<YYYYMMDD-HHmm>-<slug>.md`,
 * grouped by project the same way sessions are (cwdToSafeDirName). The
 * directory is only the initial storage location — the authoritative index is
 * the `planFiles` list in the session's plan-mode entries, which follows
 * fork/clone. Plans saved before the per-project layout stay in their legacy
 * `plans/<sessionId>/` directories and remain readable via those entries.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { cwdToSafeDirName, resolvePath } from "../../utils/paths.ts";

export interface SavePlanOptions {
	sessionId: string;
	title: string;
	plan: string;
	cwd: string;
	revises?: string;
}

/** Per-project plans directory for a cwd (same encoding as sessions). */
export function getPlansDir(cwd: string): string {
	return join(getAgentDir(), "plans", cwdToSafeDirName(resolvePath(cwd)));
}

/** File-name slug from a plan title: lowercase, ascii-ish, bounded. */
export function slugifyTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "plan";
}

/** Local-time `YYYYMMDD-HHmm` prefix: sortable and collision-poor per project. */
export function formatPlanFileStamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function buildPlanDocument(options: SavePlanOptions & { createdIso: string }): string {
	const lines = [
		"---",
		`title: ${JSON.stringify(options.title)}`,
		`created: ${options.createdIso}`,
		`cwd: ${JSON.stringify(options.cwd)}`,
		`session: ${options.sessionId}`,
	];
	if (options.revises) lines.push(`revises: ${JSON.stringify(options.revises)}`);
	lines.push("---", "", options.plan.trimEnd(), "");
	return lines.join("\n");
}

/** First non-existing `<base>.md`, `<base>-2.md`, ... path in dir. */
export function resolvePlanFileName(dir: string, base: string): string {
	let candidate = `${base}.md`;
	for (let attempt = 2; existsSync(join(dir, candidate)); attempt++) {
		candidate = `${base}-${attempt}.md`;
	}
	return candidate;
}

/**
 * Absolute paths of plans saved for this project, newest first (the
 * `YYYYMMDD-HHmm` prefix makes file names sort chronologically).
 */
export function listProjectPlanFiles(cwd: string): string[] {
	const dir = getPlansDir(cwd);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md"))
		.sort((left, right) => right.localeCompare(left))
		.map((name) => join(dir, name));
}

/** Write the plan to disk and return its absolute path. */
export function savePlanFile(options: SavePlanOptions): string {
	const dir = getPlansDir(options.cwd);
	mkdirSync(dir, { recursive: true });
	const now = new Date();
	const fileName = resolvePlanFileName(dir, `${formatPlanFileStamp(now)}-${slugifyTitle(options.title)}`);
	const path = join(dir, fileName);
	writeFileSync(path, buildPlanDocument({ ...options, createdIso: now.toISOString() }), "utf-8");
	return path;
}
