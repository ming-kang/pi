/**
 * engine.ts — file-history backup engine for the rewind extension.
 *
 * Ported from Claude Code 2.1.88's src/utils/fileHistory.ts, adapted from its
 * React state-updater to module-level per-session maps. The core idea (and the
 * reason this exists): we back up ONLY the files Pi's edit/write tools are about
 * to modify — one copyFile before the edit — instead of snapshotting the whole
 * work tree. Cost is proportional to "how many files Pi changed", not project
 * size, so it never blocks the session-lifecycle critical path and storage stays
 * tiny.
 *
 * Per turn:
 *   - beginTurn()  (before_agent_start): open a working frame and re-record every
 *     already-tracked file at its current (turn-start) state, reusing the latest
 *     backup when unchanged (worktree lastSeen → mtime/size/content), creating a
 *     new version when not. lastSeen skips backup-blob IO when the worktree has
 *     not moved since the last confirm; content compare streams in 64 KiB chunks.
 *   - trackEdit()  (tool_call edit|write, before the write): back up a *newly*
 *     edited file at its pre-edit state into the working frame (null marker when
 *     the target does not exist yet, so rewind deletes the created file).
 *   - endTurn()    (agent_settled): if anything changed, stamp + return the frame
 *     to persist; else discard it. agent_settled (not agent_end) so auto-retry /
 *     overflow compact-retry / queued follow-ups share one logical turn.
 *
 * Rewind = applySnapshot(): restore every tracked file to the version recorded in
 * the target frame (copy back / delete for null), touching only files that differ.
 *
 * Backups live at <rewindBackupsDir(sessionId)>/<sha256(relpath)[:16]>@v<n>.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, type Stats, statSync } from "node:fs";
import { chmod, copyFile, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { FileBackup, FileHistorySnapshot } from "./snapshot.ts";
import { backupsDir } from "./storage.ts";

/** Cap on retained snapshots per session (matches CC's MAX_SNAPSHOTS). */
const MAX_SNAPSHOTS = 100;
/** Avoid reading very large files solely to compare backup content. */
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;
/** Cap concurrent backup/compare/restore IO so long tracked sets don't thrash handles. */
const IO_CONCURRENCY = 16;
/** Cap bytes loaded for coarse restore line stats (confirm dialog only). */
const MAX_DIFF_BYTES = 1_048_576;
/** Streaming compare chunk size (avoids buffering whole files up to MAX_CONTENT_BYTES). */
const COMPARE_CHUNK_BYTES = 64 * 1024;

/** Worktree identity recorded when we last backed up / confirmed a tracking path. */
interface SeenStats {
	mtimeMs: number;
	size: number;
	mode: number;
}

function seenFromStats(st: Stats): SeenStats {
	return { mtimeMs: st.mtimeMs, size: st.size, mode: st.mode };
}

function sameSeen(a: SeenStats, b: Stats): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size && a.mode === b.mode;
}

export interface FileHistoryState {
	/** Finalized + persisted frames, oldest first. */
	snapshots: FileHistorySnapshot[];
	/** All tracking-paths ever edited this session. */
	trackedFiles: Set<string>;
	/** Latest backup per tracking path (finalized + in-progress pending versions). */
	latestByTracking: Map<string, FileBackup>;
	/**
	 * Worktree mtime/size/mode at the last backup or unchanged confirmation.
	 * beginTurn uses this to skip backup-blob stats/content when the worktree
	 * has not moved since we last recorded it (still stats the worktree once).
	 */
	lastSeen: Map<string, SeenStats>;
	/** The current turn's working frame (built across the turn, persisted at endTurn). */
	pending: FileHistorySnapshot | null;
	/** Whether the pending frame differs from the last finalized frame. */
	dirty: boolean;
	/** Monotonic activity counter (incremented on every finalized frame). */
	seq: number;
}

export interface ApplySnapshotOptions {
	/**
	 * Absolute paths already known to differ (e.g. from collectChanges).
	 * When set, only those paths are restored/deleted and originChanged is skipped.
	 */
	onlyPaths?: ReadonlySet<string>;
}

// ---- per-session state ----------------------------------------------------

const states = new Map<string, FileHistoryState>();
const cwds = new Map<string, string>();

function freshState(): FileHistoryState {
	return {
		snapshots: [],
		trackedFiles: new Set(),
		latestByTracking: new Map(),
		lastSeen: new Map(),
		pending: null,
		dirty: false,
		seq: 0,
	};
}

/** Run async work over items with a fixed concurrency cap. Preserves result order. */
async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!);
		}
	}
	const n = Math.min(concurrency, items.length);
	await Promise.all(Array.from({ length: n }, () => worker()));
	return results;
}

/** Rebuild latestByTracking from finalized frames (oldest → newest, last write wins). */
function rebuildLatestIndex(snapshots: FileHistorySnapshot[]): Map<string, FileBackup> {
	const latest = new Map<string, FileBackup>();
	for (const snap of snapshots) {
		for (const [tracking, backup] of Object.entries(snap.trackedFileBackups)) {
			latest.set(tracking, backup);
		}
	}
	return latest;
}

function getState(sid: string): FileHistoryState {
	let s = states.get(sid);
	if (!s) {
		s = freshState();
		states.set(sid, s);
	}
	return s;
}

/** Bind a session id to its cwd (for relative-path keying). Call at session_start. */
export function registerSession(sid: string, cwd: string): void {
	cwds.set(sid, cwd);
	getState(sid);
}

export function disposeSession(sid: string): void {
	states.delete(sid);
	cwds.delete(sid);
}

export function getSnapshots(sid: string): FileHistorySnapshot[] {
	return states.get(sid)?.snapshots ?? [];
}

function cwdFor(sid: string): string {
	return cwds.get(sid) ?? process.cwd();
}

// ---- path helpers ---------------------------------------------------------

/** Use the cwd-relative path as the tracking key when inside cwd (shorter, portable). */
function shorten(absPath: string, cwd: string): string {
	if (!isAbsolute(absPath)) return absPath;
	if (absPath === cwd) return absPath;
	const rel = relative(cwd, absPath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
	return rel;
}

function expand(tracking: string, cwd: string): string {
	return isAbsolute(tracking) ? tracking : join(cwd, tracking);
}

function backupName(tracking: string, version: number): string {
	const h = createHash("sha256").update(tracking).digest("hex").slice(0, 16);
	return `${h}@v${version}`;
}

function backupPathFor(sid: string, name: string): string {
	return join(backupsDir(sid), name);
}

function latestBackupOf(state: FileHistoryState, tracking: string): FileBackup | undefined {
	return state.latestByTracking.get(tracking);
}

/** First-ever recorded backup for a file (used when rewinding before it was tracked). */
function firstBackupName(state: FileHistoryState, tracking: string): string | null | undefined {
	for (const snap of state.snapshots) {
		const b = snap.trackedFileBackups[tracking];
		if (b && b.version === 1) return b.backupName;
	}
	return undefined;
}

/** Resolve the backup blob name for `tracking` at `target` (null = did not exist). */
function backupNameForTarget(
	state: FileHistoryState,
	target: FileHistorySnapshot,
	tracking: string,
): string | null | undefined {
	const tb = target.trackedFileBackups[tracking];
	if (tb) return tb.backupName;
	return firstBackupName(state, tracking);
}

// ---- change detection (ported fileHistory.ts compareStatsAndContent;
//      content path streams via filesEqualChunked instead of full-buffer reads)

function isENOENT(e: unknown): boolean {
	return !!e && typeof e === "object" && (e as { code?: string }).code === "ENOENT";
}

async function statOrNull(p: string): Promise<Stats | null> {
	try {
		return await stat(p);
	} catch (e) {
		if (isENOENT(e)) return null;
		throw e;
	}
}

/**
 * Raw-byte equality without buffering whole files. A utf-8 decode maps invalid
 * sequences to U+FFFD, which can make two DIFFERENT binary files compare equal —
 * and then rewind would silently skip both the re-backup and the restore.
 */
async function filesEqualChunked(aPath: string, bPath: string, size: number): Promise<boolean> {
	if (size === 0) return true;
	const [aHandle, bHandle] = await Promise.all([open(aPath, "r"), open(bPath, "r")]);
	try {
		const aBuf = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		const bBuf = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		let remaining = size;
		while (remaining > 0) {
			const want = Math.min(COMPARE_CHUNK_BYTES, remaining);
			const [aRead, bRead] = await Promise.all([
				aHandle.read(aBuf, 0, want, null),
				bHandle.read(bBuf, 0, want, null),
			]);
			if (aRead.bytesRead !== bRead.bytesRead) return false;
			if (aRead.bytesRead === 0) return remaining === 0;
			if (!aBuf.subarray(0, aRead.bytesRead).equals(bBuf.subarray(0, bRead.bytesRead))) return false;
			remaining -= aRead.bytesRead;
		}
		return true;
	} finally {
		await Promise.allSettled([aHandle.close(), bHandle.close()]);
	}
}

/** True when the on-disk file differs from its backup blob. */
async function originChanged(sid: string, filePath: string, name: string, hint?: Stats): Promise<boolean> {
	const backupPath = backupPathFor(sid, name);
	const orig = hint ?? (await statOrNull(filePath).catch(() => null));
	const back = await statOrNull(backupPath).catch(() => null);

	// One exists, one missing -> changed.
	if ((orig === null) !== (back === null)) return true;
	if (orig === null || back === null) return false;
	if (orig.mode !== back.mode || orig.size !== back.size) return true;
	// Original untouched since the backup was written -> unchanged (skip content read).
	if (orig.mtimeMs < back.mtimeMs) return false;
	// Memory guard: don't load huge files just to byte-compare; assume changed and
	// let createBackup stream a new version instead (copyFile never buffers whole files).
	if (orig.size > MAX_CONTENT_BYTES) return true;
	try {
		return !(await filesEqualChunked(filePath, backupPath, orig.size));
	} catch {
		return true;
	}
}

// ---- backup / restore IO --------------------------------------------------

/** Copy the file's current contents into a backup blob; null backup when absent. */
async function createBackup(
	sid: string,
	filePath: string,
	tracking: string,
	version: number,
	known?: Stats | null,
): Promise<FileBackup> {
	let src: Stats;
	if (known === null) return { backupName: null, version };
	if (known) {
		src = known;
	} else {
		try {
			src = await stat(filePath);
		} catch (e) {
			if (isENOENT(e)) return { backupName: null, version };
			throw e;
		}
	}
	const name = backupName(tracking, version);
	const dest = backupPathFor(sid, name);
	try {
		await copyFile(filePath, dest);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(filePath, dest);
	}
	try {
		await chmod(dest, src.mode);
	} catch {
		// best-effort (e.g. Windows); content is what matters
	}
	return { backupName: name, version };
}

/**
 * Synchronous backup, used on the edit critical path (tool_call). Doing the copy
 * synchronously guarantees it completes before the hook returns control to the
 * host — so the backup always captures the file's PRE-edit contents, regardless
 * of whether the host awaits the hook before running the tool.
 *
 * `known` reuses a pre-stat from the caller (`null` = known ENOENT) so trackEdit
 * can record lastSeen without a second statSync on the critical path.
 */
function createBackupSync(
	sid: string,
	filePath: string,
	tracking: string,
	version: number,
	known?: Stats | null,
): FileBackup {
	let src: Stats;
	if (known === null) return { backupName: null, version };
	if (known) {
		src = known;
	} else {
		try {
			src = statSync(filePath);
		} catch (e) {
			if (isENOENT(e)) return { backupName: null, version };
			throw e;
		}
	}
	const name = backupName(tracking, version);
	const dest = backupPathFor(sid, name);
	try {
		copyFileSync(filePath, dest);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(filePath, dest);
	}
	try {
		chmodSync(dest, src.mode);
	} catch {
		// best-effort
	}
	return { backupName: name, version };
}

async function restoreBackup(sid: string, filePath: string, name: string): Promise<void> {
	const backupPath = backupPathFor(sid, name);
	let back: Stats;
	try {
		back = await stat(backupPath);
	} catch {
		return; // backup vanished; leave the file untouched
	}
	try {
		await copyFile(backupPath, filePath);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		await mkdir(dirname(filePath), { recursive: true });
		await copyFile(backupPath, filePath);
	}
	try {
		await chmod(filePath, back.mode);
	} catch {
		// best-effort
	}
}

// ---- per-turn lifecycle ---------------------------------------------------

/**
 * Open the working frame for a turn and re-record every tracked file at its
 * current state (reuse latest backup when unchanged, new version when changed).
 * Sets state.dirty when any file produced a new version.
 */
export async function beginTurn(sid: string): Promise<void> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const backups: Record<string, FileBackup> = {};
	let dirty = false;

	await mapPool(Array.from(state.trackedFiles), IO_CONCURRENCY, async (tracking) => {
		try {
			const filePath = expand(tracking, cwd);
			const latest = latestBackupOf(state, tracking);
			const nextVersion = latest ? latest.version + 1 : 1;
			const st = await statOrNull(filePath);
			if (!st) {
				// Already recorded absent in the latest frame -> reuse it. Allocating a
				// fresh null version every turn would pin dirty=true forever once a
				// tracked file is deleted, defeating the "skip unchanged turns" check
				// and flushing real checkpoints out of the capped ring.
				state.lastSeen.delete(tracking);
				if (latest && latest.backupName === null) {
					backups[tracking] = latest;
					return;
				}
				const absent: FileBackup = { backupName: null, version: nextVersion };
				backups[tracking] = absent;
				state.latestByTracking.set(tracking, absent);
				dirty = true;
				return;
			}
			// Worktree identity unchanged since last backup/confirm → reuse without
			// opening the backup blob (still paid one worktree stat above).
			const seen = state.lastSeen.get(tracking);
			if (latest && latest.backupName !== null && seen && sameSeen(seen, st)) {
				backups[tracking] = latest;
				return;
			}
			if (latest && latest.backupName !== null && !(await originChanged(sid, filePath, latest.backupName, st))) {
				backups[tracking] = latest; // unchanged -> reuse
				state.lastSeen.set(tracking, seenFromStats(st));
				return;
			}
			const created = await createBackup(sid, filePath, tracking, nextVersion, st);
			backups[tracking] = created;
			state.latestByTracking.set(tracking, created);
			// Record the pre-backup worktree identity (copyFile does not change it).
			state.lastSeen.set(tracking, seenFromStats(st));
			dirty = true;
		} catch {
			// skip this file; never break the turn
		}
	});

	state.pending = { v: 1, userEntryId: "", turnId: "", prompt: "", trackedFileBackups: backups, timestamp: "" };
	state.dirty = dirty;
}

/**
 * Back up a file about to be edited/written, if not already captured this turn.
 * Call from the tool_call hook BEFORE the edit lands. ENOENT target -> null
 * marker (rewind deletes the created file). Synchronous so the backup is on disk
 * before the hook returns (see createBackupSync).
 */
export function trackEdit(sid: string, absPath: string): void {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const tracking = shorten(absPath, cwd);

	if (!state.pending) {
		state.pending = { v: 1, userEntryId: "", turnId: "", prompt: "", trackedFileBackups: {}, timestamp: "" };
	}
	if (state.pending.trackedFileBackups[tracking]) return; // already captured this turn

	const latest = latestBackupOf(state, tracking);
	const version = latest ? latest.version + 1 : 1;
	const filePath = expand(tracking, cwd);
	// One pre-edit stat: drives the backup and lastSeen (null = new-file marker).
	let preEdit: Stats | null = null;
	try {
		preEdit = statSync(filePath);
	} catch (e) {
		if (!isENOENT(e)) throw e;
	}
	const backup = createBackupSync(sid, filePath, tracking, version, preEdit);
	state.pending.trackedFileBackups[tracking] = backup;
	state.trackedFiles.add(tracking);
	state.latestByTracking.set(tracking, backup);
	if (preEdit) state.lastSeen.set(tracking, seenFromStats(preEdit));
	else state.lastSeen.delete(tracking);
	state.dirty = true;
}

/**
 * Finalize the turn. Returns the snapshot to persist (caller appendEntry's it),
 * or null when nothing changed this turn. Pushes finalized frames into the
 * in-memory ring (capped at MAX_SNAPSHOTS).
 */
export function endTurn(
	sid: string,
	userEntryId: string,
	turnId: string,
	prompt: string,
	timestamp: string,
	maxSnapshots = MAX_SNAPSHOTS,
): FileHistorySnapshot | null {
	const state = getState(sid);
	const pending = state.pending;
	state.pending = null;
	if (!pending || !state.dirty) {
		state.dirty = false;
		return null;
	}
	state.dirty = false;
	const frame: FileHistorySnapshot = { ...pending, userEntryId, turnId, prompt, timestamp };
	state.snapshots.push(frame);
	if (state.snapshots.length > maxSnapshots) {
		const dropped = state.snapshots.slice(0, state.snapshots.length - maxSnapshots);
		state.snapshots = state.snapshots.slice(-maxSnapshots);
		void pruneDroppedBlobs(sid, dropped, state.snapshots);
	}
	state.seq++;
	return frame;
}

/**
 * Best-effort deletion of backup blobs referenced ONLY by frames dropped from
 * the capped ring. Backups are reused across frames (an unchanged file keeps
 * pointing at the same version), so a blob is unlinked only when no retained
 * frame still references it. Without this, the cap trims the in-memory index
 * while the blob files accumulate for the whole session — gc.ts only reclaims
 * whole session directories.
 */
async function pruneDroppedBlobs(
	sid: string,
	dropped: FileHistorySnapshot[],
	retained: FileHistorySnapshot[],
): Promise<void> {
	const live = new Set<string>();
	for (const snap of retained) {
		for (const b of Object.values(snap.trackedFileBackups)) {
			if (b.backupName) live.add(b.backupName);
		}
	}
	const doomed = new Set<string>();
	for (const snap of dropped) {
		for (const b of Object.values(snap.trackedFileBackups)) {
			if (b.backupName && !live.has(b.backupName)) doomed.add(b.backupName);
		}
	}
	if (doomed.size === 0) return;
	await Promise.allSettled(Array.from(doomed, (name) => unlink(backupPathFor(sid, name))));
}

// ---- rewind ---------------------------------------------------------------

/**
 * Absolute paths that restoring to `target` would change on disk (empty =
 * nothing to do). Same walk applySnapshot performs, without writing — the
 * caller can both count and preview the files from one pass. Concurrent with
 * IO_CONCURRENCY; result order matches trackedFiles insertion order.
 */
export async function collectChanges(sid: string, target: FileHistorySnapshot): Promise<string[]> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const trackings = Array.from(state.trackedFiles);
	const results = await mapPool(trackings, IO_CONCURRENCY, async (tracking) => {
		try {
			const filePath = expand(tracking, cwd);
			const name = backupNameForTarget(state, target, tracking);
			if (name === undefined) return null;
			if (name === null) {
				return (await statOrNull(filePath)) ? filePath : null;
			}
			return (await originChanged(sid, filePath, name)) ? filePath : null;
		} catch {
			return null;
		}
	});
	return results.filter((p): p is string => p !== null);
}

export interface CoarseDiffStats {
	/** Absolute paths that would change (same as collectChanges). */
	paths: string[];
	/**
	 * Coarse line insertions when restoring (lines present in backup, not in
	 * current). Bag-of-lines, not a true Myers diff — confirm UI only.
	 */
	insertions: number;
	/** Coarse line deletions when restoring (lines present in current, not in backup). */
	deletions: number;
}

/**
 * Coarse +N/−M line stats for a restore confirm dialog. Only loads text for
 * paths already known to differ (from collectChanges). Oversized files still
 * appear in `paths` but contribute 0 to line totals. No extra dependency.
 */
export async function collectChangeDiffStats(
	sid: string,
	target: FileHistorySnapshot,
	changedPaths: readonly string[],
): Promise<CoarseDiffStats> {
	if (changedPaths.length === 0) {
		return { paths: [], insertions: 0, deletions: 0 };
	}
	const state = getState(sid);
	const cwd = cwdFor(sid);
	// Reverse map abs path → tracking key for the known changed set.
	const trackingByAbs = new Map<string, string>();
	for (const tracking of state.trackedFiles) {
		trackingByAbs.set(expand(tracking, cwd), tracking);
	}

	const results = await mapPool([...changedPaths], IO_CONCURRENCY, async (filePath) => {
		try {
			const tracking = trackingByAbs.get(filePath);
			if (!tracking) return { insertions: 0, deletions: 0 };
			const name = backupNameForTarget(state, target, tracking);
			if (name === undefined) return { insertions: 0, deletions: 0 };
			return await coarseLineDelta(sid, filePath, name);
		} catch {
			return { insertions: 0, deletions: 0 };
		}
	});

	let insertions = 0;
	let deletions = 0;
	for (const r of results) {
		insertions += r.insertions;
		deletions += r.deletions;
	}
	return { paths: [...changedPaths], insertions, deletions };
}

/**
 * Bag-of-lines delta for current worktree → backup target (restore direction).
 * insertions = lines that appear after restore; deletions = lines removed.
 */
async function coarseLineDelta(
	sid: string,
	filePath: string,
	backupName: string | null,
): Promise<{ insertions: number; deletions: number }> {
	const currentText = await readTextCapped(filePath, MAX_DIFF_BYTES);
	if (backupName === null) {
		// Snapshot: file did not exist → restore deletes it.
		if (currentText === null) return { insertions: 0, deletions: 0 };
		return { insertions: 0, deletions: countLines(currentText) };
	}
	const backupText = await readTextCapped(backupPathFor(sid, backupName), MAX_DIFF_BYTES);
	if (currentText === null && backupText === null) return { insertions: 0, deletions: 0 };
	if (currentText === null) return { insertions: countLines(backupText ?? ""), deletions: 0 };
	if (backupText === null) return { insertions: 0, deletions: countLines(currentText) };
	return bagOfLinesDelta(currentText, backupText);
}

/** null = missing or oversize/unreadable (skip line contrib). */
async function readTextCapped(filePath: string, maxBytes: number): Promise<string | null> {
	try {
		const st = await statOrNull(filePath);
		if (!st) return null;
		if (st.size > maxBytes) return null;
		const buf = await readFile(filePath);
		// Skip obvious binary (NUL in the first 8K).
		const sample = buf.subarray(0, Math.min(buf.length, 8192));
		if (sample.includes(0)) return null;
		return buf.toString("utf8");
	} catch {
		return null;
	}
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) n++;
	}
	// Trailing newline does not add an extra empty "line" for display counts.
	if (text.endsWith("\n")) n--;
	return Math.max(n, 0);
}

/**
 * Multiset frequency delta: from → to.
 * deletions = lines over-represented in `from`; insertions = over-represented in `to`.
 */
function bagOfLinesDelta(from: string, to: string): { insertions: number; deletions: number } {
	const fromCounts = lineFrequency(from);
	const toCounts = lineFrequency(to);
	let insertions = 0;
	let deletions = 0;
	const keys = new Set([...fromCounts.keys(), ...toCounts.keys()]);
	for (const key of keys) {
		const a = fromCounts.get(key) ?? 0;
		const b = toCounts.get(key) ?? 0;
		if (b > a) insertions += b - a;
		else if (a > b) deletions += a - b;
	}
	return { insertions, deletions };
}

function lineFrequency(text: string): Map<string, number> {
	const map = new Map<string, number>();
	// Preserve empty file as zero lines; otherwise split including last empty.
	if (text.length === 0) return map;
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		map.set(line, (map.get(line) ?? 0) + 1);
	}
	return map;
}

/**
 * Restore the work tree to `target`. Returns the list of changed file paths.
 * Pass `onlyPaths` (from a prior collectChanges) to skip a second originChanged
 * pass and only touch those absolute paths.
 */
export async function applySnapshot(
	sid: string,
	target: FileHistorySnapshot,
	opts?: ApplySnapshotOptions,
): Promise<string[]> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const only = opts?.onlyPaths;
	const trackings = Array.from(state.trackedFiles).filter((tracking) => {
		if (!only) return true;
		return only.has(expand(tracking, cwd));
	});

	const results = await mapPool(trackings, IO_CONCURRENCY, async (tracking) => {
		try {
			const filePath = expand(tracking, cwd);
			const name = backupNameForTarget(state, target, tracking);
			if (name === undefined) return null; // can't resolve -> leave file alone
			if (name === null) {
				try {
					await unlink(filePath);
					// Worktree no longer matches any recorded identity.
					state.lastSeen.delete(tracking);
					return filePath;
				} catch (e) {
					if (!isENOENT(e)) throw e;
					return null;
				}
			}
			// onlyPaths already proven different at confirm time — skip re-compare.
			if (only || (await originChanged(sid, filePath, name))) {
				await restoreBackup(sid, filePath, name);
				// Drop stale lastSeen: worktree now matches the target blob, not the
				// latest backup identity beginTurn compares against.
				state.lastSeen.delete(tracking);
				return filePath;
			}
			return null;
		} catch {
			return null;
		}
	});
	return results.filter((p): p is string => p !== null);
}

// ---- persistence rebuild + resume migration -------------------------------

/** Rebuild in-memory state from snapshots persisted in the session JSONL. */
export function restoreStateFromSnapshots(
	sid: string,
	cwd: string,
	snapshots: FileHistorySnapshot[],
	maxSnapshots = MAX_SNAPSHOTS,
): void {
	cwds.set(sid, cwd);
	// Apply the same cap on reload so a long session's JSONL can't reinflate the
	// in-memory ring past the limit. trackedFiles is rebuilt from the retained
	// frames only (older frames are unreachable for rewind anyway); blobs only
	// those frames referenced are pruned best-effort, mirroring endTurn.
	const retained = snapshots.length > maxSnapshots ? snapshots.slice(-maxSnapshots) : snapshots;
	if (retained.length < snapshots.length) {
		void pruneDroppedBlobs(sid, snapshots.slice(0, snapshots.length - retained.length), retained);
	}
	const trackedFiles = new Set<string>();
	for (const snap of retained) {
		for (const key of Object.keys(snap.trackedFileBackups)) trackedFiles.add(key);
	}
	states.set(sid, {
		snapshots: [...retained],
		trackedFiles,
		latestByTracking: rebuildLatestIndex(retained),
		// lastSeen is process-local; after reload we re-establish it on the first
		// beginTurn via originChanged / createBackup.
		lastSeen: new Map(),
		pending: null,
		dirty: false,
		seq: retained.length,
	});
}

/**
 * Hard-link this session's backup blobs from a previous session's directory
 * (resume/fork carries the conversation + its snapshot index, but the blobs live
 * under the old session id). Falls back to copy. No-op when ids match.
 */
export async function migrateBackupsFromSession(
	prevSid: string,
	sid: string,
	snapshots: FileHistorySnapshot[],
): Promise<void> {
	if (!prevSid || prevSid === sid) return;
	const destDir = backupsDir(sid);
	await mkdir(destDir, { recursive: true });
	await Promise.allSettled(
		snapshots.flatMap((snap) =>
			Object.values(snap.trackedFileBackups)
				.filter((b): b is FileBackup & { backupName: string } => b.backupName !== null)
				.map(async ({ backupName: name }) => {
					const from = join(backupsDir(prevSid), name);
					const to = join(destDir, name);
					try {
						await link(from, to);
					} catch (e) {
						const code = (e as { code?: string }).code;
						if (code === "EEXIST") return;
						try {
							await copyFile(from, to);
						} catch {
							// best-effort; a missing blob just means that version can't restore
						}
					}
				}),
		),
	);
}
