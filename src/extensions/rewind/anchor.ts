/**
 * anchor.ts — pure helper for choosing a snapshot frame's turn anchor.
 *
 * A frame records the work tree as of the moment its agent run started
 * (beginTurn at before_agent_start). The entry representing that moment is the
 * FIRST user entry the run appended — not the last user entry on the branch:
 * steering / follow-up messages consumed inside the same run append later user
 * entries, and anchoring to those would attach "start of run" file state to a
 * mid-run conversation point.
 *
 * No Pi imports, so the module stays node-testable (see storage.ts).
 */

/** Structural view of a branch entry (SessionEntry fits loosely). */
export interface BranchEntryLike {
	id: string;
	type: string;
	message?: { role?: string };
}

/**
 * The id of the first user message after `scanStartId` in `branch`
 * (root → leaf order). `scanStartId === null` scans from the root (fresh
 * session). Returns undefined when `scanStartId` is not on the branch (the
 * leaf moved across branches since it was recorded) — anchoring against an
 * unrelated prefix would mislabel the frame, so callers should discard it.
 */
export function firstUserEntryIdAfter(
	branch: readonly BranchEntryLike[],
	scanStartId: string | null,
): string | undefined {
	let start = 0;
	if (scanStartId !== null) {
		const idx = branch.findIndex((e) => e.id === scanStartId);
		if (idx < 0) return undefined;
		start = idx + 1;
	}
	for (let i = start; i < branch.length; i++) {
		const e = branch[i];
		if (e.type === "message" && e.message?.role === "user") return e.id;
	}
	return undefined;
}
