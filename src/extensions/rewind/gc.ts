/**
 * gc.ts — storage reclamation for the rewind extension's backup blobs.
 *
 * Ported from Claude Code's cleanupOldFileHistoryBackups (src/utils/cleanup.ts):
 * each session's backup directory is reaped when its mtime ages past the
 * retention window. We add an orphan sweep — a backup dir whose session id has
 * no corresponding session JSONL (e.g. a crashed/aborted session) is reclaimed
 * after a short grace period.
 *
 * runGc() is called opportunistically at session_start; it is time-boxed and
 * caps deletions per run so it can never slow startup. listSessions()/removeSession()
 * back the /rewind storage menu.
 */
import { closeSync, type Dirent, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { backupsDir, backupsRootDir, isSafeSessionId, sessionsRootDirs } from "./storage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_GRACE_MS = 1 * DAY_MS;
const GC_TIME_BUDGET_MS = 1500;
const GC_MAX_DELETIONS = 50;
const SESSION_HEADER_MAX_BYTES = 1 * 1024 * 1024;
const ACTIVE_SCAN_BUDGET_MS = 500;
const ACTIVE_SCAN_MAX_FILES = 10_000;

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

export interface SessionFileInfo {
	id: string;
	parentSession?: string;
}

/** Read the first session header without loading the complete JSONL file. */
function readSessionHeaderInfo(file: string): SessionFileInfo | undefined {
	let fd: number | undefined;
	const decoder = new StringDecoder("utf8");
	let scanned = 0;
	let pending = "";
	try {
		fd = openSync(file, "r");
		const parseLine = (line: string): SessionFileInfo | null | undefined => {
			const trimmed = line.trim();
			if (!trimmed) return undefined; // keep scanning blank prefixes
			let value: { type?: unknown; id?: unknown; parentSession?: unknown };
			try {
				value = JSON.parse(trimmed) as typeof value;
			} catch {
				return undefined; // match SessionManager's malformed-line tolerance
			}
			if (value.type !== "session") return null; // first valid non-header ends discovery
			if (typeof value.id !== "string" || !isSafeSessionId(value.id)) return null;
			return {
				id: value.id,
				...(typeof value.parentSession === "string" && value.parentSession
					? { parentSession: value.parentSession }
					: {}),
			};
		};

		const consume = (text: string): SessionFileInfo | null | undefined => {
			pending += text;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline < 0) return undefined;
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				const result = parseLine(line);
				if (result !== undefined) return result;
			}
		};

		while (scanned < SESSION_HEADER_MAX_BYTES) {
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, SESSION_HEADER_MAX_BYTES - scanned));
			const bytes = readSync(fd, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			scanned += bytes;
			const result = consume(decoder.write(buffer.subarray(0, bytes)));
			if (result !== undefined) return result ?? undefined;
		}
		pending += decoder.end();
		return parseLine(pending) ?? undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Read a session's authoritative id/parent from its header. For a nonexistent
 * path, retain a filename fallback for legacy callers and tests.
 */
export function sessionInfoFromFile(file: string, allowFilenameFallback = true): SessionFileInfo | undefined {
	if (existsSync(file)) return readSessionHeaderInfo(file);
	if (!allowFilenameFallback) return undefined;
	const name = basename(file).replace(/\.jsonl$/i, "");
	const us = name.lastIndexOf("_");
	const id = us >= 0 ? name.slice(us + 1) : name;
	return isSafeSessionId(id) ? { id } : undefined;
}

/** Extract a session id, preferring the JSONL header over the filename shape. */
export function sessionIdFromFile(file: string, allowFilenameFallback = true): string | undefined {
	return sessionInfoFromFile(file, allowFilenameFallback)?.id;
}

/** Backup session directories on disk (one per session id). */
function backupDirNames(): string[] {
	try {
		return readdirSync(backupsRootDir(), { withFileTypes: true })
			.filter((d) => d.isDirectory() && isSafeSessionId(d.name))
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

function addSessionFile(ids: Set<string>, file: string, knownSessionIds: readonly string[]): void {
	if (!/\.jsonl$/i.test(file)) return;
	const info = sessionInfoFromFile(file);
	if (info) {
		ids.add(info.id);
		return;
	}
	// If a file is temporarily unreadable, protect a backup whose full legal id
	// is unambiguously present in its filename rather than reaping it as orphan.
	const name = basename(file).replace(/\.jsonl$/i, "");
	const candidates = knownSessionIds.filter((id) => name.endsWith(`_${id}`)).sort((a, b) => b.length - a.length);
	if (candidates[0]) ids.add(candidates[0]);
}

interface ActiveSessionScan {
	ids: Set<string>;
	complete: boolean;
}

/**
 * Bounded active-session discovery. If the scan is incomplete, callers must
 * disable orphan deletion rather than guessing about unvisited session files.
 */
function scanActiveSessionIds(): ActiveSessionScan {
	const ids = new Set<string>();
	const knownSessionIds = backupDirNames();
	const started = Date.now();
	let scannedFiles = 0;
	let complete = true;

	const shouldStop = (): boolean =>
		Date.now() - started >= ACTIVE_SCAN_BUDGET_MS || scannedFiles >= ACTIVE_SCAN_MAX_FILES;
	const scanFile = (file: string): boolean => {
		if (shouldStop()) return false;
		scannedFiles++;
		addSessionFile(ids, file, knownSessionIds);
		return true;
	};

	scan: for (const root of sessionsRootDirs()) {
		if (shouldStop()) {
			complete = false;
			break;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (shouldStop()) {
				complete = false;
				break scan;
			}
			const path = join(root, entry.name);
			if (entry.isFile()) {
				if (!scanFile(path)) {
					complete = false;
					break scan;
				}
				continue;
			}
			if (!entry.isDirectory()) continue;
			let files: Dirent[];
			try {
				files = readdirSync(path, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.isFile()) continue;
				if (!scanFile(join(path, file.name))) {
					complete = false;
					break scan;
				}
			}
		}
	}
	return { ids, complete };
}

/** Session ids that still have a session JSONL under every known session root. */
export function activeSessionIds(): Set<string> {
	return scanActiveSessionIds().ids;
}

/** Inventory of on-disk backup storage (for the /rewind storage menu). */
export function listSessions(currentSessionId?: string): SessionStorage[] {
	const scan = scanActiveSessionIds();
	const active = scan.ids;
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
			orphan: scan.complete && sessionId !== currentSessionId && !active.has(sessionId),
		});
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Remove one session's backup directory. Returns bytes reclaimed, or null on failure. */
export function removeSession(sessionId: string): number | null {
	if (!isSafeSessionId(sessionId)) return null;
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
	const scan = scanActiveSessionIds();
	const active = scan.ids;
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
		const orphan = scan.complete && !active.has(sessionId) && mtimeMs < orphanCutoff;
		if (!aged && !orphan) continue;
		const bytes = removeSession(sessionId);
		if (bytes !== null) {
			removed++;
			reclaimedBytes += bytes;
		}
	}
	return { removed, reclaimedBytes };
}
