/**
 * storage.ts — injected storage roots for the rewind extension.
 *
 * engine.ts and gc.ts must stay loadable under plain node (for offline
 * selftests), so they cannot statically import paths.ts (which imports
 * getAgentDir from @astralyn/pi — unresolvable outside Pi).
 * Instead they read the roots from here, and the integration layer (index.ts)
 * calls configureStorage() with the real paths at startup. Selftests call it
 * with temp directories.
 *
 * No Pi imports in this module.
 */
import { join, resolve } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

let backupsRoot = "";
let sessionsRoot = "";
let additionalSessionsRoots: string[] = [];

/** Session IDs are directory names and must never be allowed to escape backupsRoot. */
export function isSafeSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Bind the on-disk roots. Called once by index.ts (or by selftests). */
export function configureStorage(opts: {
	backupsRoot: string;
	sessionsRoot: string;
	sessionsRoots?: readonly string[];
}): void {
	backupsRoot = opts.backupsRoot;
	sessionsRoot = opts.sessionsRoot;
	additionalSessionsRoots = [];
	for (const root of opts.sessionsRoots ?? []) registerSessionsRoot(root);
}

/** Add a session directory discovered from a custom SessionManager configuration. */
export function registerSessionsRoot(root: string): void {
	if (!root) return;
	const normalized = resolve(root);
	if ((sessionsRoot && normalized === resolve(sessionsRoot)) || additionalSessionsRoots.includes(normalized)) return;
	additionalSessionsRoots.push(normalized);
}

/** Root holding every session's backup directory. */
export function backupsRootDir(): string {
	return backupsRoot;
}

/** A single session's backup directory. */
export function backupsDir(sessionId: string): string {
	if (!isSafeSessionId(sessionId)) throw new Error("Invalid rewind session id");
	return join(backupsRoot, sessionId);
}

/** Default root holding Pi's session JSONL files. */
export function sessionsRootDir(): string {
	return sessionsRoot;
}

/** All known session roots, including custom roots registered at session start. */
export function sessionsRootDirs(): string[] {
	const roots = sessionsRoot ? [resolve(sessionsRoot), ...additionalSessionsRoots] : [...additionalSessionsRoots];
	return [...new Set(roots)];
}
