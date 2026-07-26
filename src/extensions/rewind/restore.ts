/**
 * restore.ts — map a /tree navigation target to the snapshot that should be
 * restored and apply it via the engine.
 */
import {
	type ApplySnapshotOptions,
	applySnapshot,
	type CoarseDiffStats,
	collectChangeDiffStats,
	collectChanges,
} from "./engine.ts";
import type { FileHistorySnapshot } from "./snapshot.ts";

/** Minimal session view we need to walk the entry tree. */
export interface EntryTreeView {
	getEntry(id: string): { id: string; parentId: string | null } | undefined;
}

/** Collect the ancestor id set of `targetId` (inclusive), walking parentId to root. */
export function ancestorIds(view: EntryTreeView, targetId: string): Set<string> {
	const set = new Set<string>();
	let cur: string | null = targetId;
	let guard = 0;
	while (cur && !set.has(cur) && guard++ < 100_000) {
		set.add(cur);
		cur = view.getEntry(cur)?.parentId ?? null;
	}
	return set;
}

/**
 * The snapshot that best matches navigating to `targetId`: the most recent
 * snapshot (chronological) whose turn anchor (userEntryId) is an ancestor of, or
 * equal to, the target. Undefined when no recorded turn precedes the target.
 */
export function snapshotForEntry(
	snapshots: FileHistorySnapshot[],
	view: EntryTreeView,
	targetId: string,
): FileHistorySnapshot | undefined {
	const ancestors = ancestorIds(view, targetId);
	let best: FileHistorySnapshot | undefined;
	for (const snap of snapshots) {
		if (ancestors.has(snap.userEntryId)) best = snap; // snapshots are in chronological order
	}
	return best;
}

/**
 * Absolute file paths restoring to this snapshot would change on disk (empty =
 * none). Callers use the length for the count and the paths for the preview.
 */
export function snapshotChangedPaths(sessionId: string, snapshot: FileHistorySnapshot): Promise<string[]> {
	return collectChanges(sessionId, snapshot);
}

/**
 * Coarse +N/−M line stats for the confirm dialog (paths must already be known
 * changed — typically from snapshotChangedPaths).
 */
export function snapshotChangeDiffStats(
	sessionId: string,
	snapshot: FileHistorySnapshot,
	changedPaths: readonly string[],
): Promise<CoarseDiffStats> {
	return collectChangeDiffStats(sessionId, snapshot, changedPaths);
}

/**
 * Restore the work tree to `snapshot` and return changed absolute paths.
 * Pass `onlyPaths` from a prior snapshotChangedPaths call to skip re-compare.
 */
export async function restoreToSnapshot(
	sessionId: string,
	snapshot: FileHistorySnapshot,
	opts?: ApplySnapshotOptions,
): Promise<string[]> {
	return applySnapshot(sessionId, snapshot, opts);
}
