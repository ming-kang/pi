/**
 * gc.ts — storage reclamation for the rewind extension's backup blobs.
 *
 * Ported from Claude Code's cleanupOldFileHistoryBackups (src/utils/cleanup.ts):
 * each session's backup directory is reaped when its mtime ages past the
 * retention window. We add an orphan sweep — a backup dir whose session id has no
 * corresponding session JSONL (e.g. a crashed/aborted session) is reclaimed after
 * a short grace period.
 *
 * runGc() is called opportunistically at session_start; it is time-boxed and
 * caps deletions per run so it can never slow startup. listSessions()/removeSession()
 * back the /rewind storage menu.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { backupsDir, backupsRootDir, sessionsRootDir } from "./storage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_GRACE_MS = 1 * DAY_MS;
const GC_TIME_BUDGET_MS = 1500;
const GC_MAX_DELETIONS = 50;

export interface SessionStorage {
	sessionId: string;
	dir: string;
	bytes: number;
	mtimeMs: number;
	orphan: boolean;
}

export interface GcResult {
	removed: number;
	reclaimedBytes: number;
}

/**
 * Extract a session id from a session JSONL path/filename (`..._<id>.jsonl`).
 * Format-agnostic (no hardcoded id shape) so it stays correct if Pi changes its
 * session-id format. Shared with the integration layer (index.ts) so the two
 * parsers can't drift — a stricter parser here could miss active sessions and
 * wrongly reap their backups as orphans.
 */
export function sessionIdFromFile(file: string): string | undefined {
	const b = basename(file).replace(/\.jsonl$/i, "");
	const us = b.lastIndexOf("_");
	const id = us >= 0 ? b.slice(us + 1) : b;
	return id || undefined;
}

/** Backup session directories on disk (one per session id). */
function backupDirNames(): string[] {
	try {
		return readdirSync(backupsRootDir(), { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return []; // root doesn't exist yet
	}
}

/** Total byte size of a directory's immediate files (backups are flat). */
function dirSize(dir: string): number {
	let bytes = 0;
	try {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			if (!d.isFile()) continue;
			try {
				bytes += statSync(join(dir, d.name)).size;
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
	return bytes;
}

/**
 * Session ids that still have a session JSONL under <agentDir>/sessions/.
 * Files are named `<ISO>_<sessionId>.jsonl`, nested one level under an
 * encoded-cwd directory.
 */
export function activeSessionIds(): Set<string> {
	const ids = new Set<string>();
	const root = sessionsRootDir();
	let projectDirs: string[];
	try {
		projectDirs = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(root, d.name));
	} catch {
		return ids;
	}
	for (const pd of projectDirs) {
		let files: string[];
		try {
			files = readdirSync(pd);
		} catch {
			continue;
		}
		for (const f of files) {
			const id = sessionIdFromFile(f);
			if (id) ids.add(id);
		}
	}
	return ids;
}

/** Inventory of on-disk backup storage (for the /rewind storage menu). */
export function listSessions(currentSessionId?: string): SessionStorage[] {
	const active = activeSessionIds();
	const out: SessionStorage[] = [];
	for (const sessionId of backupDirNames()) {
		const dir = backupsDir(sessionId);
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(dir).mtimeMs;
		} catch {
			continue;
		}
		out.push({
			sessionId,
			dir,
			bytes: dirSize(dir),
			mtimeMs,
			orphan: sessionId !== currentSessionId && !active.has(sessionId),
		});
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Remove one session's backup directory. Returns bytes reclaimed, or null on failure. */
export function removeSession(sessionId: string): number | null {
	const dir = backupsDir(sessionId);
	try {
		const bytes = dirSize(dir);
		rmSync(dir, { recursive: true, force: true });
		return bytes;
	} catch {
		return null;
	}
}

/**
 * Reclaim aged + orphaned backup directories. Time-boxed and deletion-capped so
 * it never slows session_start. Skips age GC when retentionDays <= 0 ("forever").
 */
export function runGc(retentionDays: number, currentSessionId?: string): GcResult {
	const start = Date.now();
	const ageCutoff = retentionDays > 0 ? start - retentionDays * DAY_MS : -Infinity;
	const orphanCutoff = start - ORPHAN_GRACE_MS;
	const active = activeSessionIds();
	let removed = 0;
	let reclaimedBytes = 0;

	for (const sessionId of backupDirNames()) {
		if (removed >= GC_MAX_DELETIONS || Date.now() - start > GC_TIME_BUDGET_MS) break;
		if (sessionId === currentSessionId) continue;
		const dir = backupsDir(sessionId);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(dir).mtimeMs;
		} catch {
			continue;
		}
		const aged = mtimeMs < ageCutoff;
		const orphan = !active.has(sessionId) && mtimeMs < orphanCutoff;
		if (!aged && !orphan) continue;
		const bytes = removeSession(sessionId);
		if (bytes !== null) {
			removed++;
			reclaimedBytes += bytes;
		}
	}
	return { removed, reclaimedBytes };
}
