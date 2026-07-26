/**
 * plan/storage.ts — plan file layout and writing.
 *
 * Plans live under `<agentDir>/plans/<sessionId>/NN-<slug>.md`, append-only
 * with a monotonically increasing NN. The directory is only the initial
 * storage location — the authoritative index is the `planFiles` list in the
 * session's plan-mode entries, which follows fork/clone.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

export interface SavePlanOptions {
	sessionId: string;
	title: string;
	plan: string;
	cwd: string;
	revises?: string;
}

export function getPlansDir(sessionId: string): string {
	return join(getAgentDir(), "plans", sessionId);
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

/** Next NN based on existing `NN-*.md` names; gaps never reuse numbers. */
export function nextPlanNumber(existingNames: string[]): number {
	let max = 0;
	for (const name of existingNames) {
		const match = /^(\d+)-/.exec(name);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
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

/** Write the plan to disk and return its absolute path. */
export function savePlanFile(options: SavePlanOptions): string {
	const dir = getPlansDir(options.sessionId);
	mkdirSync(dir, { recursive: true });
	const number = nextPlanNumber(readdirSync(dir));
	const fileName = `${String(number).padStart(2, "0")}-${slugifyTitle(options.title)}.md`;
	const path = join(dir, fileName);
	writeFileSync(path, buildPlanDocument({ ...options, createdIso: new Date().toISOString() }), "utf-8");
	return path;
}
