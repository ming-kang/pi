/**
 * storage.ts — injected storage roots for the rewind engine.
 *
 * engine.ts and gc.ts must stay loadable under plain node (for offline
 * selftests), so they cannot statically import paths.ts (which imports
 * getAgentDir from @earendil-works/pi-coding-agent — unresolvable outside Pi).
 * Instead they read the roots from here, and the integration layer (index.ts)
 * calls configureStorage() with the real paths at startup. Selftests call it with
 * temp directories.
 *
 * No Pi imports in this module.
 */
import { join } from "node:path";

let backupsRoot = "";
let sessionsRoot = "";

/** Bind the on-disk roots. Called once by index.ts (or by selftests). */
export function configureStorage(opts: { backupsRoot: string; sessionsRoot: string }): void {
	backupsRoot = opts.backupsRoot;
	sessionsRoot = opts.sessionsRoot;
}

/** Root holding every session's backup directory. */
export function backupsRootDir(): string {
	return backupsRoot;
}

/** A single session's backup directory. */
export function backupsDir(sessionId: string): string {
	return join(backupsRoot, sessionId);
}

/** Root holding Pi's session JSONL files (for orphan detection). */
export function sessionsRootDir(): string {
	return sessionsRoot;
}
