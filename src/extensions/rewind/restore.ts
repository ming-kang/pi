/**
 * restore.ts — map a /tree navigation target to the snapshot that should be
 * restored and apply it via the engine.
 *
 * Snapshot semantics: a frame anchored at user entry U records the work tree
 * at the moment U's run STARTED (see engine.ts beginTurn). The selection here
 * must mirror AgentSession.navigateTree's leaf rules:
 *
 *   - user / custom_message target: navigateTree removes the target's turn
 *     from the branch (leaf = parent, text returns to the editor) → restore
 *     to the state BEFORE that turn = the snapshot anchored at the target.
 *   - any other target: the target's turn STAYS in the conversation
 *     (leaf = target) → restore to the state AFTER that turn = the first
 *     chronological snapshot anchored at a descendant turn (it recorded the
 *     work tree when the next run began). No such snapshot → nothing was
 *     recorded after the target, so offer no restore at all — falling back to
 *     an ancestor frame would roll back the target turn's own edits and leave
 *     the work tree older than the conversation.
 */
import {
	type ApplySnapshotOptions,
	applySnapshot,
	type CoarseDiffStats,
	collectChangeDiffStats,
	collectChanges,
} from "./engine.ts";
import type { FileHistorySnapshot } from "./snapshot.ts";

/** Minimal per-entry view needed to walk the tree and classify targets. */
export interface EntryView {
	id: string;
	parentId: string | null;
	/** True for entries navigateTree treats as turn starts (user / custom_message → leaf = parent). */
	isTurnAnchor: boolean;
}

/** Minimal session view we need to walk the entry tree. */
export interface EntryTreeView {
	getEntry(id: string): EntryView | undefined;
}

/** Cycle guard for parent-chain walks (ids are acyclic in practice). */
const ANCESTOR_WALK_GUARD = 100_000;

/** True when `id`'s parent chain passes through `ancestorId` (strict descent). */
function isDescendantOf(view: EntryTreeView, id: string, ancestorId: string): boolean {
	let cur = view.getEntry(id)?.parentId ?? null;
	let guard = 0;
	while (cur !== null && guard++ < ANCESTOR_WALK_GUARD) {
		if (cur === ancestorId) return true;
		cur = view.getEntry(cur)?.parentId ?? null;
	}
	return false;
}

/**
 * First (chronological) snapshot anchored at a strict descendant of `entryId`
 * — the run that started right after `entryId` existed, so its frame records
 * the work tree state "just after" the entry.
 */
function snapshotAfterEntry(
	snapshots: FileHistorySnapshot[],
	view: EntryTreeView,
	entryId: string,
): FileHistorySnapshot | undefined {
	for (const snap of snapshots) {
		if (!snap.userEntryId) continue;
		if (isDescendantOf(view, snap.userEntryId, entryId)) return snap;
	}
	return undefined;
}

/**
 * The snapshot that matches navigating to `targetId`, per the rules in the
 * module header. Undefined when no recorded state corresponds to the target
 * (then the work tree should be left alone).
 */
export function snapshotForEntry(
	snapshots: FileHistorySnapshot[],
	view: EntryTreeView,
	targetId: string,
): FileHistorySnapshot | undefined {
	const target = view.getEntry(targetId);
	if (!target) return undefined;

	if (target.isTurnAnchor) {
		// Exact anchor match: the frame recording the state right before this
		// turn ran. Chronologically last wins if duplicate anchors exist.
		let exact: FileHistorySnapshot | undefined;
		for (const snap of snapshots) {
			if (snap.userEntryId === targetId) exact = snap;
		}
		if (exact) return exact;
		// No frame for this turn (it recorded no changes): the state before it
		// equals the state after its parent.
		return target.parentId === null ? undefined : snapshotAfterEntry(snapshots, view, target.parentId);
	}

	return snapshotAfterEntry(snapshots, view, targetId);
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
