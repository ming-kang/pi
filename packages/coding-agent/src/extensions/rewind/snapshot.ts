/**
 * snapshot.ts — persisted data shapes for the rewind extension's file-history
 * engine. Pure types + tiny helpers; no Pi imports, no side effects, so the
 * engine and its selftests can import them under plain node.
 *
 * A FileHistorySnapshot is written to the session JSONL (via the integration
 * layer's appendEntry, custom type "pi-rewind-snapshot"). It is never sent to
 * the LLM and survives reload/compaction. Each snapshot anchors to one turn and
 * records, for every tracked file, which backup blob holds that file's contents
 * as of the start of the turn.
 */

/** Custom session-entry type used to persist snapshots to the session JSONL. */
export const SNAPSHOT_ENTRY_TYPE = "pi-rewind-snapshot";

/**
 * One file's backup at a specific version.
 * `backupName === null` means the file did not exist at this version — rewinding
 * to a snapshot carrying a null backup deletes the file.
 */
export interface FileBackup {
	/** Backup blob filename (`<sha256(relpath)[:16]>@v<n>`), or null if the file did not exist. */
	backupName: string | null;
	/** Monotonic version for this file within the session (1-based). */
	version: number;
}

/**
 * One turn's snapshot. `v` lets future readers migrate old entries.
 * `trackedFileBackups` is keyed by the file's path *relative to cwd* when inside
 * cwd (else the absolute path), matching the engine's path shortening.
 */
export interface FileHistorySnapshot {
	v: 1;
	/** Session entry id this snapshot anchors to (used to match /tree navigation). */
	userEntryId: string;
	/** Leaf/turn id when finalized (informational). */
	turnId: string;
	/** The user prompt that drove the turn (truncated; shown in the /tree sync prompt). */
	prompt: string;
	/** Map of tracking-path → the backup recorded for that file at the start of this turn. */
	trackedFileBackups: Record<string, FileBackup>;
	/** ISO timestamp the snapshot was finalized. */
	timestamp: string;
}

/** Narrow an arbitrary session-entry payload to a FileHistorySnapshot. */
export function isSnapshot(data: unknown): data is FileHistorySnapshot {
	if (!data || typeof data !== "object") return false;
	const s = data as Partial<FileHistorySnapshot>;
	return (
		typeof s.userEntryId === "string" && typeof s.trackedFileBackups === "object" && s.trackedFileBackups !== null
	);
}
