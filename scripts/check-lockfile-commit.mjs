#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const UPSTREAM_SCOPE = "@earendil-works/";
const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return lockPath || "<root>";
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packageLabel(lockPath, entry) {
	const name = entry?.name ?? packageNameFromLockPath(lockPath);
	return entry?.version ? `${name}@${entry.version}` : name;
}

function describeChange({ lockPath, oldEntry, newEntry }) {
	if (lockPath === "") return "changed root package";
	if (!oldEntry) return `added ${packageLabel(lockPath, newEntry)}`;
	if (!newEntry) return `removed ${packageLabel(lockPath, oldEntry)}`;
	if (oldEntry.version !== newEntry.version) {
		return `changed ${packageNameFromLockPath(lockPath)} ${oldEntry.version ?? "<none>"} -> ${newEntry.version ?? "<none>"}`;
	}
	return `changed ${packageLabel(lockPath, newEntry)}`;
}

// The root entry without its version and upstream specs, which routine changes may move.
function stripRoutineRootFields(entry) {
	const rest = { ...entry };
	delete rest.version;
	for (const group of DEPENDENCY_GROUPS) {
		if (!rest[group]) continue;
		rest[group] = Object.fromEntries(
			Object.entries(rest[group]).filter(([name]) => !name.startsWith(UPSTREAM_SCOPE)),
		);
	}
	return rest;
}

function isRoutineRootChange(oldEntry, newEntry, upstreamVersion) {
	if (!oldEntry || !newEntry) return false;
	if (!isDeepStrictEqual(stripRoutineRootFields(oldEntry), stripRoutineRootFields(newEntry))) return false;
	return DEPENDENCY_GROUPS.every((group) =>
		Object.entries(newEntry[group] ?? {}).every(
			([name, spec]) =>
				!name.startsWith(UPSTREAM_SCOPE) || oldEntry[group]?.[name] === spec || spec === upstreamVersion,
		),
	);
}

function isRoutineChange({ lockPath, oldEntry, newEntry }, upstreamVersion) {
	if (lockPath === "") return isRoutineRootChange(oldEntry, newEntry, upstreamVersion);
	const name = newEntry?.name ?? packageNameFromLockPath(lockPath);
	return name.startsWith(UPSTREAM_SCOPE) && newEntry?.version === upstreamVersion;
}

/**
 * Compare two lockfiles. A change is routine, and needs no acknowledgement, when
 * it only moves the root version and @earendil-works packages to the recorded
 * upstream version: a release commit or a plain synchronization. Anything else
 * needs a reviewed PI_ALLOW_LOCKFILE_CHANGE.
 */
export function classifyLockfileChanges(before, after, upstreamVersion) {
	const changes = [];
	const paths = new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})]);
	for (const lockPath of [...paths].sort()) {
		const oldEntry = before.packages?.[lockPath];
		const newEntry = after.packages?.[lockPath];
		if (!isDeepStrictEqual(oldEntry, newEntry)) changes.push({ lockPath, oldEntry, newEntry });
	}
	const outside = { ...before, packages: undefined, version: undefined };
	const routine =
		isDeepStrictEqual(outside, { ...after, packages: undefined, version: undefined }) &&
		changes.every((change) => isRoutineChange(change, upstreamVersion));
	return { routine, summary: changes.map(describeChange) };
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJsonFromGit(ref) {
	try {
		return JSON.parse(git(["show", ref]));
	} catch {
		return undefined;
	}
}

function main() {
	const stagedFiles = git(["diff", "--cached", "--name-only"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!stagedFiles.includes("npm-shrinkwrap.json")) return 0;

	const before = readJsonFromGit("HEAD:npm-shrinkwrap.json");
	const after = readJsonFromGit(":npm-shrinkwrap.json");
	const upstreamTag = readJsonFromGit(":maintainers/upstream.json")?.tag;
	const result =
		before?.packages && after?.packages && typeof upstreamTag === "string"
			? classifyLockfileChanges(before, after, upstreamTag.slice(1))
			: { routine: false, summary: [] };
	if (result.routine) {
		console.error(`npm-shrinkwrap.json: accepted routine change (${result.summary.length} entries).`);
		return 0;
	}

	console.error("npm-shrinkwrap.json is staged with changes beyond the root version and upstream packages.");
	console.error("");
	console.error("Review lockfile changes before committing:");
	console.error("  - confirm every new/updated package is intentional");
	console.error("  - confirm npm age gates were active, or record the authorized release-specific exception");
	console.error("  - review any new lifecycle scripts in the dependency tree");
	console.error("  - confirm npm-shrinkwrap.json matches package.json and the intended runtime tree");
	if (result.summary.length > 0) {
		console.error("");
		console.error("Detected package changes (including dependency metadata):");
		for (const change of result.summary.slice(0, 40)) console.error(`  - ${change}`);
		if (result.summary.length > 40) console.error(`  ... ${result.summary.length - 40} more`);
	}

	const allowValue = process.env.PI_ALLOW_LOCKFILE_CHANGE;
	if (allowValue === "1" || allowValue === "true" || allowValue === "yes") {
		console.error("PI_ALLOW_LOCKFILE_CHANGE is set: accepting the reviewed lockfile change above.");
		return 0;
	}
	console.error("");
	console.error("After reviewing this intentional lockfile change, commit with:");
	console.error("  PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
	return 1;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
	process.exitCode = main();
}
