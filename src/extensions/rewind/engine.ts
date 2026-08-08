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
 *     backup when unchanged (content compare for bounded files; metadata
 *     fingerprint for oversized files), creating a new version when not.
 *     Content comparison streams in 64 KiB chunks and treats uncertainty as
 *     changed.
 *   - trackEdit()  (tool_call edit|write, before the write): back up a *newly*
 *     edited file at its pre-edit state into the working frame (null marker when
 *     the target does not exist yet, so rewind deletes the created file).
 *   - endTurn()    (agent_settled): if anything changed AND the caller resolved a
 *     turn anchor, stamp + return the frame to persist; else discard it (an
 *     unanchored frame could never be matched by /tree and would exist only in
 *     memory). agent_settled (not agent_end) so auto-retry / overflow
 *     compact-retry / queued follow-ups share one logical turn.
 *
 * Rewind = applySnapshot(): restore every tracked file to the version recorded in
 * the target frame (copy back / delete for null), touching only files that differ.
 *
 * Backups live at <rewindBackupsDir(sessionId)>/<sha256(relpath)[:16]>@v<n>.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { chmod, copyFile, link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { type FileBackup, type FileHistorySnapshot, isSafeBackupName } from "./snapshot.ts";
import { backupsDir } from "./storage.ts";

/** Cap on retained snapshots per session (matches CC's MAX_SNAPSHOTS). */
const MAX_SNAPSHOTS = 100;
/** Avoid reading very large files solely to compare backup content. */
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;
/** Cap concurrent backup/compare/restore IO so long tracked sets don't thrash handles. */
const IO_CONCURRENCY = 16;
/** Limit fork/resume blob migration so large histories do not fan out thousands of copies. */
const MIGRATION_CONCURRENCY = 16;
/** Cap bytes loaded for coarse restore line stats (confirm dialog only). */
const MAX_DIFF_BYTES = 1_048_576;
/** Streaming compare chunk size (avoids buffering whole files up to MAX_CONTENT_BYTES). */
const COMPARE_CHUNK_BYTES = 64 * 1024;

/** Metadata fingerprint used only to avoid re-reading oversized files. */
interface SeenStats {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	mode: number;
	ino: number;
	dev: number;
	contentHash?: string;
}

function seenFromStats(st: Stats, contentHash?: string): SeenStats {
	return {
		mtimeMs: st.mtimeMs,
		ctimeMs: st.ctimeMs,
		size: st.size,
		mode: st.mode,
		ino: st.ino,
		dev: st.dev,
		...(contentHash ? { contentHash } : {}),
	};
}

function sameSeen(a: SeenStats, b: Stats): boolean {
	return (
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.size === b.size &&
		a.mode === b.mode &&
		a.ino === b.ino &&
		a.dev === b.dev
	);
}

export interface FileHistoryState {
	/** Finalized + persisted frames whose blobs are still retained, oldest first. */
	snapshots: FileHistorySnapshot[];
	/**
	 * Anchors from the chronological prefix evicted by maxSnapshots. Keeping the
	 * tiny metadata lets /tree distinguish "no frame was ever written" from "the
	 * exact frame existed but is no longer restorable" and fail closed.
	 */
	droppedSnapshotAnchors: string[];
	/** All tracking-paths ever edited this session. */
	trackedFiles: Set<string>;
	/** Latest backup per tracking path (finalized + in-progress pending versions). */
	latestByTracking: Map<string, FileBackup>;
	/** Metadata fingerprint for oversized-file fast paths. */
	lastSeen: Map<string, SeenStats>;
	/** Digest cache for immutable backup blobs, keyed by blob name. */
	backupDigests: Map<string, string>;
	/** Metadata fingerprint paired with each cached blob digest. */
	backupSeen: Map<string, SeenStats>;
	/** The current turn's working frame (built across the turn, persisted at endTurn). */
	pending: FileHistorySnapshot | null;
	/** Paths that failed capture for the current frame; retries can clear them. */
	pendingFailures: Set<string>;
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
		droppedSnapshotAnchors: [],
		trackedFiles: new Set(),
		latestByTracking: new Map(),
		lastSeen: new Map(),
		backupDigests: new Map(),
		backupSeen: new Map(),
		pending: null,
		pendingFailures: new Set(),
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

/** Chronological anchors whose frames were evicted and can no longer restore. */
export function getDroppedSnapshotAnchors(sid: string): readonly string[] {
	return states.get(sid)?.droppedSnapshotAnchors ?? [];
}

function cwdFor(sid: string): string {
	return cwds.get(sid) ?? process.cwd();
}

// ---- path helpers ---------------------------------------------------------

let tempCopySequence = 0;

function temporaryCopyPath(destination: string): string {
	tempCopySequence = (tempCopySequence + 1) % 1_000_000_000;
	return `${destination}.pi-rewind-${process.pid}-${tempCopySequence}.tmp`;
}

interface AtomicCopyOptions {
	mode?: number;
	computeSha256?: boolean;
	expectedSha256?: string;
}

/** Copy via a same-directory temporary file so a failed or corrupt copy never truncates the target. */
async function copyFileAtomic(
	source: string,
	destination: string,
	options: AtomicCopyOptions = {},
): Promise<string | undefined> {
	await mkdir(dirname(destination), { recursive: true });
	const temporary = temporaryCopyPath(destination);
	try {
		await copyFile(source, temporary);
		if (options.mode !== undefined) {
			try {
				await chmod(temporary, options.mode);
			} catch {
				// best-effort (e.g. Windows); content is what matters
			}
		}
		const digest =
			options.computeSha256 || options.expectedSha256 !== undefined ? await fileDigest(temporary) : undefined;
		if (options.expectedSha256 !== undefined && digest !== options.expectedSha256) {
			throw new Error("Rewind backup integrity check failed");
		}
		await rename(temporary, destination);
		return digest;
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

/** Synchronous one-pass counterpart used before edit/write tools execute. */
function copyFileAtomicSync(source: string, destination: string, mode?: number): string {
	mkdirSync(dirname(destination), { recursive: true });
	const temporary = temporaryCopyPath(destination);
	let sourceFd: number | undefined;
	let destinationFd: number | undefined;
	try {
		sourceFd = openSync(source, "r");
		destinationFd = openSync(temporary, "w");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		for (;;) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				written += writeSync(destinationFd, buffer, written, bytesRead - written);
			}
		}
		closeSync(sourceFd);
		sourceFd = undefined;
		closeSync(destinationFd);
		destinationFd = undefined;
		if (mode !== undefined) {
			try {
				chmodSync(temporary, mode);
			} catch {
				// best-effort
			}
		}
		renameSync(temporary, destination);
		return hash.digest("hex");
	} finally {
		if (sourceFd !== undefined) closeSync(sourceFd);
		if (destinationFd !== undefined) closeSync(destinationFd);
		try {
			unlinkSync(temporary);
		} catch {
			// already renamed or never created
		}
	}
}

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

function emptyBackupMap(): Record<string, FileBackup> {
	return Object.create(null) as Record<string, FileBackup>;
}

function backupPathFor(sid: string, name: string): string {
	if (!isSafeBackupName(name)) throw new Error("Invalid rewind backup name");
	return join(backupsDir(sid), name);
}

function latestBackupOf(state: FileHistoryState, tracking: string): FileBackup | undefined {
	return state.latestByTracking.get(tracking);
}

/** First-ever recorded backup for a file (used when rewinding before it was tracked). */
function firstBackup(state: FileHistoryState, tracking: string): FileBackup | undefined {
	for (const snap of state.snapshots) {
		const backup = Object.hasOwn(snap.trackedFileBackups, tracking) ? snap.trackedFileBackups[tracking] : undefined;
		if (backup && backup.version === 1 && (backup.backupName === null || isSafeBackupName(backup.backupName))) {
			return backup;
		}
	}
	return undefined;
}

/** Resolve the backup metadata for `tracking` at `target`. */
function backupForTarget(
	state: FileHistoryState,
	target: FileHistorySnapshot,
	tracking: string,
): FileBackup | undefined {
	if (Object.hasOwn(target.trackedFileBackups, tracking)) {
		const backup = target.trackedFileBackups[tracking];
		if (backup.backupName === null || isSafeBackupName(backup.backupName)) return backup;
		return undefined;
	}
	return firstBackup(state, tracking);
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
/** Stream a file into a SHA-256 digest without buffering its contents. */
async function fileDigest(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	const hash = createHash("sha256");
	try {
		const buffer = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		for (;;) {
			const result = await handle.read(buffer, 0, buffer.length, null);
			if (result.bytesRead === 0) break;
			hash.update(buffer.subarray(0, result.bytesRead));
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

/** True when the on-disk file differs from its backup blob. */
async function originChanged(
	sid: string,
	filePath: string,
	name: string,
	hint?: Stats,
	currentHash?: string,
	backupHash?: string,
): Promise<boolean> {
	const backupPath = backupPathFor(sid, name);
	const orig = hint ?? (await statOrNull(filePath).catch(() => null));
	const back = await statOrNull(backupPath).catch(() => null);

	// One exists, one missing -> changed.
	if ((orig === null) !== (back === null)) return true;
	if (orig === null || back === null) return false;
	if (orig.mode !== back.mode || orig.size !== back.size) return true;
	// Always compare content for bounded files. mtime/size/mode alone can be
	// preserved by archive extraction, copy -p, or an external replacement.
	if (orig.size > MAX_CONTENT_BYTES) {
		try {
			const actualHash = currentHash ?? (await fileDigest(filePath));
			return actualHash !== (backupHash ?? (await fileDigest(backupPath)));
		} catch {
			return true;
		}
	}
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
	const mode = src.mode;
	const digest = await copyFileAtomic(filePath, dest, { mode, computeSha256: true });
	if (!digest) throw new Error("Rewind backup digest was not produced");
	return { backupName: name, version, sha256: digest };
}

/**
 * Synchronous backup, used on the edit critical path (tool_call). Doing the copy
 * synchronously guarantees it completes before the hook returns control to the
 * host — so the backup always captures the file's PRE-edit contents, regardless
 * of whether the host awaits the hook before running the tool.
 *
 * `known` reuses a pre-stat from the caller (`null` = known ENOENT) so trackEdit
 * can avoid a second statSync on the critical path.
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
	const digest = copyFileAtomicSync(filePath, dest, src.mode);
	return { backupName: name, version, sha256: digest };
}

async function restoreBackup(sid: string, filePath: string, backup: FileBackup): Promise<boolean> {
	if (backup.backupName === null) return false;
	const backupPath = backupPathFor(sid, backup.backupName);
	let back: Stats;
	try {
		back = await stat(backupPath);
	} catch {
		return false; // backup vanished; leave the file untouched and report unavailable
	}
	if (!back.isFile()) return false;
	try {
		await copyFileAtomic(backupPath, filePath, { mode: back.mode, expectedSha256: backup.sha256 });
	} catch {
		return false;
	}
	return true;
}

async function verifyBackupIntegrity(state: FileHistoryState, sid: string, backup: FileBackup): Promise<Stats | null> {
	if (backup.backupName === null) return null;
	const backupPath = backupPathFor(sid, backup.backupName);
	const stats = await statOrNull(backupPath).catch(() => null);
	if (!stats?.isFile()) return null;
	if (!backup.sha256) return stats; // legacy snapshots predate integrity metadata
	const cachedStats = state.backupSeen.get(backup.backupName);
	if (state.backupDigests.get(backup.backupName) === backup.sha256 && cachedStats && sameSeen(cachedStats, stats)) {
		return stats;
	}
	try {
		const actual = await fileDigest(backupPath);
		if (actual !== backup.sha256) {
			state.backupDigests.delete(backup.backupName);
			state.backupSeen.delete(backup.backupName);
			return null;
		}
		state.backupDigests.set(backup.backupName, actual);
		state.backupSeen.set(backup.backupName, seenFromStats(stats));
		return stats;
	} catch {
		return null;
	}
}

/**
 * Open the working frame for a turn and re-record every tracked file at its
 * current state (reuse latest backup when unchanged, new version when changed).
 * Sets state.dirty when any file produced a new version.
 */
export async function beginTurn(sid: string): Promise<void> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const backups: Record<string, FileBackup> = Object.create(null) as Record<string, FileBackup>;
	let dirty = false;
	state.pendingFailures.clear();

	await mapPool(Array.from(state.trackedFiles), IO_CONCURRENCY, async (tracking) => {
		try {
			const filePath = expand(tracking, cwd);
			const latest = latestBackupOf(state, tracking);
			let usableLatest = latest;
			if (latest && latest.backupName !== null && !(await verifyBackupIntegrity(state, sid, latest))) {
				usableLatest = undefined;
			}
			const nextVersion = latest ? latest.version + 1 : 1;
			const st = await statOrNull(filePath);
			if (!st) {
				// Already recorded absent in the latest frame -> reuse it. Allocating a
				// fresh null version every turn would pin dirty=true forever once a
				// tracked file is deleted, defeating the "skip unchanged turns" check
				// and flushing real checkpoints out of the capped ring.
				state.lastSeen.delete(tracking);
				if (usableLatest && usableLatest.backupName === null) {
					backups[tracking] = usableLatest;
					return;
				}
				const absent: FileBackup = { backupName: null, version: nextVersion };
				backups[tracking] = absent;
				state.latestByTracking.set(tracking, absent);
				dirty = true;
				return;
			}
			const seen = state.lastSeen.get(tracking);
			const isLarge = st.size > MAX_CONTENT_BYTES;
			let currentHash: string | undefined;
			let comparedLarge = false;
			if (usableLatest && usableLatest.backupName !== null && isLarge) {
				const backupPath = backupPathFor(sid, usableLatest.backupName);
				const backupExists = (await statOrNull(backupPath).catch(() => null))?.isFile() === true;
				if (seen?.contentHash && sameSeen(seen, st) && backupExists) {
					// The immutable blob and the complete metadata fingerprint are
					// unchanged; do not stream a multi-gigabyte worktree file every turn.
					backups[tracking] = usableLatest;
					return;
				}
				if (backupExists) {
					currentHash = await fileDigest(filePath);
					const backupHash = state.backupDigests.get(usableLatest.backupName) ?? (await fileDigest(backupPath));
					state.backupDigests.set(usableLatest.backupName, backupHash);
					comparedLarge = true;
					if (currentHash === backupHash) {
						backups[tracking] = usableLatest;
						state.lastSeen.set(tracking, seenFromStats(st, currentHash));
						return;
					}
				}
			}
			if (
				usableLatest &&
				usableLatest.backupName !== null &&
				!comparedLarge &&
				!(await originChanged(
					sid,
					filePath,
					usableLatest.backupName,
					st,
					currentHash,
					state.backupDigests.get(usableLatest.backupName),
				))
			) {
				backups[tracking] = usableLatest; // unchanged -> reuse
				state.lastSeen.set(tracking, seenFromStats(st, currentHash));
				return;
			}
			const created = await createBackup(sid, filePath, tracking, nextVersion, st);
			backups[tracking] = created;
			state.latestByTracking.set(tracking, created);
			if (isLarge && !currentHash) currentHash = await fileDigest(filePath);
			if (created.backupName !== null && created.sha256) {
				state.backupDigests.set(created.backupName, created.sha256);
				const backupStats = await statOrNull(backupPathFor(sid, created.backupName));
				if (backupStats?.isFile()) state.backupSeen.set(created.backupName, seenFromStats(backupStats));
			}
			state.lastSeen.set(tracking, seenFromStats(st, currentHash));
			dirty = true;
		} catch {
			// Do not persist a partial frame: its omitted path would otherwise fall
			// back to an older backup and restore the wrong pre-turn state.
			state.pendingFailures.add(tracking);
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
/**
 * Reuse an existing tracking key that differs only by case (Windows paths are
 * case-insensitive): two keys for one physical file would race each other in
 * applySnapshot's concurrent restore.
 */
function canonicalTracking(state: FileHistoryState, tracking: string): string {
	if (process.platform !== "win32" || state.trackedFiles.has(tracking)) return tracking;
	const lower = tracking.toLowerCase();
	for (const existing of state.trackedFiles) {
		if (existing.toLowerCase() === lower) return existing;
	}
	return tracking;
}

export function trackEdit(sid: string, absPath: string): void {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const tracking = canonicalTracking(state, shorten(absPath, cwd));

	if (!state.pending) {
		state.pending = {
			v: 1,
			userEntryId: "",
			turnId: "",
			prompt: "",
			trackedFileBackups: emptyBackupMap(),
			timestamp: "",
		};
		state.pendingFailures.clear();
	}
	if (Object.hasOwn(state.pending.trackedFileBackups, tracking)) return; // already captured this turn

	try {
		const latest = latestBackupOf(state, tracking);
		const version = latest ? latest.version + 1 : 1;
		const filePath = expand(tracking, cwd);
		// One pre-edit stat: drives the backup (null = new-file marker).
		let preEdit: Stats | null = null;
		try {
			preEdit = statSync(filePath);
		} catch (e) {
			if (!isENOENT(e)) throw e;
		}
		const backup = createBackupSync(sid, filePath, tracking, version, preEdit);
		state.pending.trackedFileBackups[tracking] = backup;
		state.pendingFailures.delete(tracking);
		state.trackedFiles.add(tracking);
		state.latestByTracking.set(tracking, backup);
		if (backup.backupName !== null && backup.sha256) {
			state.backupDigests.set(backup.backupName, backup.sha256);
			try {
				state.backupSeen.set(backup.backupName, seenFromStats(statSync(backupPathFor(sid, backup.backupName))));
			} catch {
				// The blob will be checked lazily before it is reused.
			}
		}
		if (preEdit) state.lastSeen.set(tracking, seenFromStats(preEdit));
		else state.lastSeen.delete(tracking);
		state.dirty = true;
	} catch (error) {
		state.pendingFailures.add(tracking);
		throw error;
	}
}

/** Discard an unpersisted working frame and remove blobs it introduced. */
function discardWorkingFrame(sid: string, state: FileHistoryState, pending: FileHistorySnapshot): void {
	const live = new Set<string>();
	for (const snapshot of state.snapshots) {
		for (const backup of Object.values(snapshot.trackedFileBackups)) {
			if (backup.backupName && isSafeBackupName(backup.backupName)) live.add(backup.backupName);
		}
	}
	for (const [tracking, backup] of Object.entries(pending.trackedFileBackups)) {
		state.lastSeen.delete(tracking);
		if (!backup.backupName || live.has(backup.backupName) || !isSafeBackupName(backup.backupName)) continue;
		state.backupDigests.delete(backup.backupName);
		state.backupSeen.delete(backup.backupName);
		try {
			unlinkSync(backupPathFor(sid, backup.backupName));
		} catch {
			// Best effort; session GC can reclaim an unreferenced blob later.
		}
	}
	state.latestByTracking = rebuildLatestIndex(state.snapshots);
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
	const pendingComplete = state.pendingFailures.size === 0;
	state.pending = null;
	state.pendingFailures.clear();
	if (!pending || !pendingComplete || !state.dirty) {
		if (pending && state.dirty) discardWorkingFrame(sid, state, pending);
		state.dirty = false;
		return null;
	}
	state.dirty = false;
	// No resolvable anchor (e.g. a custom-triggered run that appended no user
	// entry): discard the frame. Pushing it into the ring without persisting it
	// would diverge memory from the JSONL, and /tree could never match it anyway.
	if (!userEntryId) {
		discardWorkingFrame(sid, state, pending);
		return null;
	}
	const frame: FileHistorySnapshot = { ...pending, userEntryId, turnId, prompt, timestamp };
	state.snapshots.push(frame);
	if (state.snapshots.length > maxSnapshots) {
		const dropped = state.snapshots.slice(0, state.snapshots.length - maxSnapshots);
		state.snapshots = state.snapshots.slice(-maxSnapshots);
		for (const snapshot of dropped) {
			if (snapshot.userEntryId) state.droppedSnapshotAnchors.push(snapshot.userEntryId);
		}
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
			if (b.backupName && isSafeBackupName(b.backupName)) live.add(b.backupName);
		}
	}
	const doomed = new Set<string>();
	for (const snap of dropped) {
		for (const b of Object.values(snap.trackedFileBackups)) {
			if (b.backupName && isSafeBackupName(b.backupName) && !live.has(b.backupName)) doomed.add(b.backupName);
		}
	}
	if (doomed.size === 0) return;
	const state = getState(sid);
	for (const name of doomed) {
		state.backupDigests.delete(name);
		state.backupSeen.delete(name);
	}
	await Promise.allSettled(Array.from(doomed, (name) => unlink(backupPathFor(sid, name))));
}

// ---- rewind ---------------------------------------------------------------

export interface SnapshotChangePlan {
	/** Paths that differ and have enough backup data to restore safely. */
	changedPaths: string[];
	/** Paths whose target state cannot be resolved or whose blob is unavailable. */
	unavailablePaths: string[];
}

/**
 * Build a fail-closed restore plan. Missing target metadata or blob files are
 * reported separately and never enter the set offered for restoration.
 */
export async function collectChangePlan(sid: string, target: FileHistorySnapshot): Promise<SnapshotChangePlan> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const trackings = Array.from(state.trackedFiles);
	const results = await mapPool(trackings, IO_CONCURRENCY, async (tracking) => {
		const filePath = expand(tracking, cwd);
		try {
			const backup = backupForTarget(state, target, tracking);
			if (backup === undefined) return { path: filePath, kind: "unavailable" as const };
			if (backup.backupName === null) {
				return (await statOrNull(filePath)) ? { path: filePath, kind: "changed" as const } : null;
			}
			if (!(await verifyBackupIntegrity(state, sid, backup))) {
				return { path: filePath, kind: "unavailable" as const };
			}
			const backupHash = state.backupDigests.get(backup.backupName);
			return (await originChanged(sid, filePath, backup.backupName, undefined, undefined, backupHash))
				? { path: filePath, kind: "changed" as const }
				: null;
		} catch {
			return { path: filePath, kind: "unavailable" as const };
		}
	});
	const changedPaths: string[] = [];
	const unavailablePaths: string[] = [];
	for (const result of results) {
		if (!result) continue;
		if (result.kind === "changed") changedPaths.push(result.path);
		else unavailablePaths.push(result.path);
	}
	return { changedPaths, unavailablePaths };
}

/** Absolute paths that differ and have an available target backup. */
export async function collectChanges(sid: string, target: FileHistorySnapshot): Promise<string[]> {
	return (await collectChangePlan(sid, target)).changedPaths;
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
			const backup = backupForTarget(state, target, tracking);
			if (!backup || backup.backupName === null) return { insertions: 0, deletions: 0 };
			return await coarseLineDelta(sid, filePath, backup.backupName);
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

export interface ApplySnapshotResult {
	/** Paths actually restored or deleted. */
	changedPaths: string[];
	/** Selected paths left untouched because their target could not be restored. */
	unavailablePaths: string[];
}

/** Restore with explicit partial-failure reporting for the interactive UI. */
export async function applySnapshotDetailed(
	sid: string,
	target: FileHistorySnapshot,
	opts?: ApplySnapshotOptions,
): Promise<ApplySnapshotResult> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const only = opts?.onlyPaths;
	const trackings = Array.from(state.trackedFiles).filter((tracking) => {
		if (!only) return true;
		return only.has(expand(tracking, cwd));
	});

	const results = await mapPool(trackings, IO_CONCURRENCY, async (tracking) => {
		const filePath = expand(tracking, cwd);
		try {
			const backup = backupForTarget(state, target, tracking);
			if (backup === undefined) return { path: filePath, kind: "unavailable" as const };
			if (backup.backupName === null) {
				try {
					await unlink(filePath);
					// Worktree no longer matches any recorded identity.
					state.lastSeen.delete(tracking);
					return { path: filePath, kind: "changed" as const };
				} catch (e) {
					if (!isENOENT(e)) throw e;
					return null;
				}
			}
			if (!(await verifyBackupIntegrity(state, sid, backup))) {
				return { path: filePath, kind: "unavailable" as const };
			}
			const backupHash = state.backupDigests.get(backup.backupName);
			// onlyPaths already proved different at confirm time; the restore still
			// verifies that the blob exists and reports a concurrent disappearance.
			if (only || (await originChanged(sid, filePath, backup.backupName, undefined, undefined, backupHash))) {
				if (!(await restoreBackup(sid, filePath, backup))) {
					return { path: filePath, kind: "unavailable" as const };
				}
				// Drop the pre-restore fingerprint; the worktree now matches the target blob.
				state.lastSeen.delete(tracking);
				return { path: filePath, kind: "changed" as const };
			}
			return null;
		} catch {
			return { path: filePath, kind: "unavailable" as const };
		}
	});
	const changedPaths: string[] = [];
	const unavailablePaths: string[] = [];
	for (const result of results) {
		if (!result) continue;
		if (result.kind === "changed") changedPaths.push(result.path);
		else unavailablePaths.push(result.path);
	}
	return { changedPaths, unavailablePaths };
}

/** Restore the work tree and return only paths actually changed. */
export async function applySnapshot(
	sid: string,
	target: FileHistorySnapshot,
	opts?: ApplySnapshotOptions,
): Promise<string[]> {
	return (await applySnapshotDetailed(sid, target, opts)).changedPaths;
}

// ---- persistence rebuild + fork migration -------------------------------

/** The trailing window of `snapshots` retained under the cap (endTurn's ring). */
export function capSnapshots(snapshots: FileHistorySnapshot[], maxSnapshots = MAX_SNAPSHOTS): FileHistorySnapshot[] {
	return snapshots.length > maxSnapshots ? snapshots.slice(-maxSnapshots) : snapshots;
}

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
	const retained = capSnapshots(snapshots, maxSnapshots);
	const dropped = snapshots.slice(0, snapshots.length - retained.length);
	if (dropped.length > 0) {
		void pruneDroppedBlobs(sid, dropped, retained);
	}
	const trackedFiles = new Set<string>();
	for (const snap of retained) {
		for (const key of Object.keys(snap.trackedFileBackups)) trackedFiles.add(key);
	}
	states.set(sid, {
		snapshots: [...retained],
		droppedSnapshotAnchors: dropped.map((snapshot) => snapshot.userEntryId).filter(Boolean),
		trackedFiles,
		latestByTracking: rebuildLatestIndex(retained),
		lastSeen: new Map(),
		backupDigests: new Map(),
		backupSeen: new Map(),
		pending: null,
		pendingFailures: new Set(),
		dirty: false,
		seq: retained.length,
	});
}

async function backupFilesEqual(aPath: string, bPath: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([stat(aPath), stat(bPath)]);
		if (!a.isFile() || !b.isFile() || a.mode !== b.mode || a.size !== b.size) return false;
		return await filesEqualChunked(aPath, bPath, a.size);
	} catch {
		return false;
	}
}

/**
 * Hard-link a fork's retained backup blobs from its parent session. Falls back
 * to copy across devices. An existing destination is content-checked; a stale
 * collision is replaced from the authoritative parent instead of being trusted.
 */
export async function migrateBackupsFromSession(
	prevSid: string,
	sid: string,
	snapshots: FileHistorySnapshot[],
): Promise<void> {
	if (!prevSid || prevSid === sid) return;
	const destDir = backupsDir(sid);
	await mkdir(destDir, { recursive: true });
	const names = new Set<string>();
	const expectedDigests = new Map<string, string>();
	const conflictingDigests = new Set<string>();
	for (const snap of snapshots) {
		for (const backup of Object.values(snap.trackedFileBackups)) {
			if (!isSafeBackupName(backup.backupName)) continue;
			names.add(backup.backupName);
			if (!backup.sha256 || conflictingDigests.has(backup.backupName)) continue;
			const previous = expectedDigests.get(backup.backupName);
			if (previous && previous !== backup.sha256) {
				expectedDigests.delete(backup.backupName);
				conflictingDigests.add(backup.backupName);
			} else {
				expectedDigests.set(backup.backupName, backup.sha256);
			}
		}
	}
	await mapPool(Array.from(names), MIGRATION_CONCURRENCY, async (name) => {
		const from = join(backupsDir(prevSid), name);
		const to = join(destDir, name);
		try {
			const source = await statOrNull(from).catch(() => null);
			if (!source?.isFile()) {
				// A stale destination cannot be trusted when the authoritative parent
				// blob is gone; remove it so future restores fail closed.
				await unlink(to).catch(() => undefined);
				return;
			}
			const expectedSha256 = expectedDigests.get(name);
			if (conflictingDigests.has(name)) {
				await unlink(to).catch(() => undefined);
				return;
			}
			if (expectedSha256) {
				try {
					if ((await fileDigest(from)) !== expectedSha256) {
						await unlink(to).catch(() => undefined);
						return;
					}
				} catch {
					await unlink(to).catch(() => undefined);
					return;
				}
			}
			try {
				await link(from, to);
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (code === "EEXIST") {
					let equal = false;
					try {
						equal = await backupFilesEqual(from, to);
					} catch {
						// Fall through to an atomic source copy when comparison is inconclusive.
					}
					if (equal) return;
				}
				try {
					await copyFileAtomic(from, to, { mode: source.mode, expectedSha256 });
				} catch {
					// A failed migration must not leave a stale or partial destination
					// blob that later looks restorable.
					await unlink(to).catch(() => undefined);
				}
			}
		} catch {
			await unlink(to).catch(() => undefined);
		}
	});
}
