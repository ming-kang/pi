import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { canonicalizePath, resolvePath } from "./paths.ts";

// realpathSync keeps the caller's drive-letter case on Windows, so C:\repo and c:\repo
// canonicalize to different strings for the same directory. relative() compares
// case-insensitively on win32; stored keys also need a dev:ino comparison.

/** True when both paths resolve to the same location. */
export function samePath(left: string | undefined, right: string): boolean {
	return left !== undefined && relative(canonicalizePath(left), canonicalizePath(right)) === "";
}

/** True when `child` is strictly inside `parent`. */
export function isPathInside(parent: string, child: string): boolean {
	const relativePath = relative(canonicalizePath(parent), canonicalizePath(child));
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function pathKey(value: string): string {
	const normalized = canonicalizePath(resolvePath(value));
	return process.platform === "win32"
		? normalized.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
		: normalized;
}

function fileIdentity(value: string): string | undefined {
	try {
		const stats = statSync(value, { bigint: true });
		return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
	} catch {
		return undefined;
	}
}

function referToSameLocation(left: string, right: string): boolean {
	const leftKey = pathKey(left);
	const rightKey = pathKey(right);
	if (leftKey === rightKey) return true;
	if (process.platform !== "win32") return false;
	const leftIdentity = fileIdentity(leftKey);
	return leftIdentity !== undefined && leftIdentity === fileIdentity(rightKey);
}

/** Keys of a path-keyed record that name `path`, including other spellings on Windows. */
export function findPathKeys(record: Record<string, unknown>, path: string): string[] {
	if (process.platform !== "win32") return Object.hasOwn(record, path) ? [path] : [];
	return Object.keys(record).filter((key) => referToSameLocation(key, path));
}

/**
 * Matcher for the user-global ~/.agents/skills directory. HOME and the account's home
 * directory can differ (for example under MSYS), so both count as the user's home.
 */
export function userAgentsSkillsDirMatcher(): (dir: string) => boolean {
	const homes = [process.env.HOME || homedir()];
	try {
		homes.push(userInfo().homedir);
	} catch {
		// Some restricted runtimes cannot query the operating-system account database.
	}
	const skillDirs = homes.map((home) => join(pathKey(home), ".agents", "skills"));
	return (dir) => skillDirs.some((skillDir) => referToSameLocation(skillDir, dir));
}
