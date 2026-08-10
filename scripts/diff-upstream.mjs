#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prerelease, satisfies, valid, validRange } from "semver";

const runtimeDependencyNames = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"];
const manifestKeys = ["repository", "tag", "commit", "sourceSubtree", "sourceTree"];
const deltaRequiredKeys = ["path", "category", "intent"];
const deltaAllowedKeys = [...deltaRequiredKeys, "tests"];
const deltaCategories = ["ui", "bugfix", "extension-support", "distribution", "windows-compat"];

const usage = `Usage: node scripts/diff-upstream.mjs [--check]

Compares the current worktree against the recorded upstream baseline
in maintainers/upstream.json, annotated with the per-path deviation
ledger in maintainers/deltas.json.

  (no flag)  print the deterministic full classification report
  --check    verify baseline, dependencies, and ledger coverage and print a concise count summary`;

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function isStableSemver(value) {
	return typeof value === "string" && valid(value) === value && prerelease(value) === null;
}

export function normalizeRepository(value) {
	if (typeof value !== "string") return undefined;
	const parts = value.split("/");
	if (parts.length !== 2) return undefined;
	const [owner, repo] = parts;
	if (!/^[A-Za-z\d](?:[A-Za-z\d-]{0,37})$/.test(owner) || owner.endsWith("-")) return undefined;
	if (!/^[A-Za-z\d](?:[A-Za-z\d._-]{0,99})$/.test(repo) || repo.endsWith(".")) return undefined;
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function validateManifest(manifest) {
	const failures = [];
	if (!isPlainObject(manifest)) {
		failures.push("maintainers/upstream.json must be a JSON object");
		return failures;
	}
	for (const key of manifestKeys) {
		if (!Object.hasOwn(manifest, key)) {
			failures.push(`maintainers/upstream.json is missing required key "${key}"`);
		}
	}
	for (const key of Object.keys(manifest)) {
		if (!manifestKeys.includes(key)) {
			failures.push(`maintainers/upstream.json has unexpected key "${key}"`);
		}
	}
	if (failures.length > 0) return failures;

	if (!normalizeRepository(manifest.repository)) {
		failures.push("repository must be a canonical GitHub owner/repository pair");
	}
	if (typeof manifest.tag !== "string" || !manifest.tag.startsWith("v") || !isStableSemver(manifest.tag.slice(1))) {
		failures.push("tag must be an exact stable release tag (v<semver>)");
	}
	if (!/^[0-9a-f]{40}$/.test(manifest.commit)) {
		failures.push("commit must be a lowercase 40-hex Git commit ID");
	}
	if (!/^[0-9a-f]{40}$/.test(manifest.sourceTree)) {
		failures.push("sourceTree must be a lowercase 40-hex Git tree ID");
	}
	const sub = manifest.sourceSubtree;
	if (
		!isNonEmptyString(sub) ||
		sub.startsWith("/") ||
		sub.endsWith("/") ||
		sub.includes("\\") ||
		sub !== posix.normalize(sub) ||
		sub.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		failures.push("sourceSubtree must be an exact canonical POSIX path without leading/trailing slashes");
	}

	return failures;
}

function isValidDeltaPath(value) {
	return (
		isNonEmptyString(value) &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value === posix.normalize(value) &&
		!value.split("/").some((part) => part === "" || part === "." || part === "..")
	);
}

/**
 * Validate maintainers/deltas.json. Entries with a trailing "/" register a
 * whole directory prefix; all other entries register one exact file.
 */
export function validateDeltas(deltas, root, failures) {
	if (!isPlainObject(deltas) || !Array.isArray(deltas.deltas) || Object.keys(deltas).length !== 1) {
		failures.push('maintainers/deltas.json must be an object with a single "deltas" array');
		return [];
	}
	const entries = [];
	const seenPaths = new Set();
	for (const [index, entry] of deltas.deltas.entries()) {
		const location = `maintainers/deltas.json entry ${index}`;
		if (!isPlainObject(entry)) {
			failures.push(`${location} must be an object`);
			continue;
		}
		for (const key of deltaRequiredKeys) {
			if (!Object.hasOwn(entry, key)) failures.push(`${location} is missing required key "${key}"`);
		}
		for (const key of Object.keys(entry)) {
			if (!deltaAllowedKeys.includes(key)) failures.push(`${location} has unexpected key "${key}"`);
		}
		const isPrefix = typeof entry.path === "string" && entry.path.endsWith("/");
		const normalizedPath = isPrefix ? entry.path.slice(0, -1) : entry.path;
		if (!isValidDeltaPath(normalizedPath)) {
			failures.push(`${location} path must be a normalized repository-relative POSIX path`);
			continue;
		}
		if (seenPaths.has(entry.path)) {
			failures.push(`maintainers/deltas.json has a duplicate path "${entry.path}"`);
		}
		seenPaths.add(entry.path);
		if (!deltaCategories.includes(entry.category)) {
			failures.push(`${location} category must be one of: ${deltaCategories.join(", ")}`);
		}
		if (!isNonEmptyString(entry.intent)) {
			failures.push(`${location} intent must be a non-empty string`);
		}
		if (Object.hasOwn(entry, "tests")) {
			if (!Array.isArray(entry.tests) || entry.tests.some((test) => !isNonEmptyString(test))) {
				failures.push(`${location} tests must be an array of repository-relative paths`);
			} else {
				for (const test of entry.tests) {
					if (!existsSync(join(root, test))) {
						failures.push(`${location} references a test path that does not exist: ${test}`);
					}
				}
			}
		}
		entries.push(entry);
	}
	const paths = entries.map((entry) => entry.path);
	const sorted = [...paths].sort();
	if (paths.some((path, index) => path !== sorted[index])) {
		failures.push("maintainers/deltas.json entries must be sorted by path");
	}
	return entries;
}

/** Match an entry: an exact path wins over the longest registered directory prefix. */
export function findDelta(deltaEntries, path) {
	let prefixMatch;
	for (const entry of deltaEntries) {
		if (entry.path === path) return entry;
		if (
			entry.path.endsWith("/") &&
			path.startsWith(entry.path) &&
			(prefixMatch === undefined || entry.path.length > prefixMatch.path.length)
		) {
			prefixMatch = entry;
		}
	}
	return prefixMatch;
}

export function createGit(root) {
	const cwd = resolve(root);
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
	const tryGit = (...args) => {
		try {
			return git(...args);
		} catch {
			return undefined;
		}
	};
	return { git, tryGit };
}

function parseJson(text, location, failures) {
	try {
		return JSON.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		failures.push(`${location} is not valid JSON${detail}`);
		return undefined;
	}
}

function readJsonFile(path, location, failures) {
	try {
		return parseJson(readFileSync(path, "utf8"), location, failures);
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		failures.push(`cannot read ${location}${detail}`);
		return undefined;
	}
}

function verifyBaseline(manifest, failures, warnings, tryGit) {
	const sourceTreeType = tryGit("cat-file", "-t", manifest.sourceTree);
	let upstreamPackage;
	if (sourceTreeType !== "tree") {
		failures.push(
			`sourceTree ${manifest.sourceTree} is not available as a tree object; fetch upstream tags or update maintainers/upstream.json`,
		);
	} else {
		const sourcePackageText = tryGit("show", `${manifest.sourceTree}:package.json`);
		if (sourcePackageText === undefined) {
			failures.push(`sourceTree ${manifest.sourceTree} does not contain package.json`);
		} else {
			upstreamPackage = parseJson(sourcePackageText, `${manifest.sourceTree}:package.json`, failures);
		}
	}

	const tagRef = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${manifest.tag}`);
	if (tagRef !== undefined) {
		const tagCommit = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${manifest.tag}^{commit}`);
		if (!tagCommit) {
			failures.push(`tag ${manifest.tag} does not resolve to a commit`);
		} else {
			if (tagCommit !== manifest.commit) {
				failures.push(
					`manifest commit ${manifest.commit} does not match tag ${manifest.tag} commit (${tagCommit})`,
				);
			}
			const tagTree = tryGit("rev-parse", "--verify", "--quiet", `${tagCommit}:${manifest.sourceSubtree}`);
			if (!tagTree) {
				failures.push(`tag ${manifest.tag} does not contain source subtree ${manifest.sourceSubtree}`);
			} else {
				const tagTreeType = tryGit("cat-file", "-t", tagTree);
				if (tagTreeType !== "tree") {
					failures.push(`tag ${manifest.tag}:${manifest.sourceSubtree} is not a tree`);
				} else if (tagTree !== manifest.sourceTree) {
					failures.push(
						`manifest sourceTree ${manifest.sourceTree} does not match ${manifest.tag}:${manifest.sourceSubtree} tree (${tagTree})`,
					);
				}
			}
		}
	} else if (sourceTreeType === "tree") {
		warnings.push(
			`tag ${manifest.tag} is unavailable locally; using recorded canonical source tree ${manifest.sourceTree.slice(0, 12)}`,
		);
	}

	return upstreamPackage;
}

function verifyRuntimeDependencies(upstreamPackage, manifest, failures, root) {
	const packageJson = readJsonFile(join(root, "package.json"), "package.json", failures);
	const shrinkwrap = readJsonFile(join(root, "npm-shrinkwrap.json"), "npm-shrinkwrap.json", failures);

	const localVersions = {};
	if (packageJson !== undefined) {
		if (!isPlainObject(packageJson)) {
			failures.push("package.json must be a JSON object");
		} else if (!isPlainObject(packageJson.dependencies)) {
			failures.push("package.json.dependencies must be an object");
		} else {
			for (const dep of runtimeDependencyNames) {
				const ver = packageJson.dependencies[dep];
				if (!isStableSemver(ver)) {
					failures.push(
						`package.json dependency ${dep} must be an exact stable semver; found ${JSON.stringify(ver)}`,
					);
				} else {
					localVersions[dep] = ver;
				}
			}
		}
	}

	if (shrinkwrap !== undefined) {
		if (!isPlainObject(shrinkwrap)) {
			failures.push("npm-shrinkwrap.json must be a JSON object");
		} else {
			const packages = shrinkwrap.packages;
			if (!isPlainObject(packages)) {
				failures.push("npm-shrinkwrap.json.packages must be an object");
			} else {
				const rootPkg = packages[""];
				if (!isPlainObject(rootPkg) || !isPlainObject(rootPkg.dependencies)) {
					failures.push('npm-shrinkwrap.json.packages[""].dependencies must be an object');
				} else {
					for (const dep of runtimeDependencyNames) {
						if (localVersions[dep] && rootPkg.dependencies[dep] !== localVersions[dep]) {
							failures.push(
								`npm-shrinkwrap.json root spec for ${dep} (${String(rootPkg.dependencies[dep])}) does not match package.json (${localVersions[dep]})`,
							);
						}
					}
				}

				for (const dep of runtimeDependencyNames) {
					const installed = packages[`node_modules/${dep}`];
					if (!isPlainObject(installed)) {
						failures.push(`npm-shrinkwrap.json is missing installed entry node_modules/${dep}`);
					} else if (localVersions[dep] && installed.version !== localVersions[dep]) {
						failures.push(
							`npm-shrinkwrap.json installed version for ${dep} (${String(installed.version)}) does not match package.json (${localVersions[dep]})`,
						);
					}
				}
			}
		}
	}

	if (upstreamPackage !== undefined) {
		if (!isPlainObject(upstreamPackage)) {
			failures.push("baseline package.json must be a JSON object");
		} else {
			const expectedVersion = manifest.tag.slice(1);
			if (upstreamPackage.version !== expectedVersion) {
				failures.push(
					`baseline package.json version (${JSON.stringify(upstreamPackage.version)}) does not match manifest tag ${manifest.tag}`,
				);
			}
			if (!isPlainObject(upstreamPackage.dependencies)) {
				failures.push("baseline package.json dependencies must be an object");
			} else {
				for (const dep of runtimeDependencyNames) {
					const localVer = localVersions[dep];
					const upstreamRange = upstreamPackage.dependencies[dep];
					if (typeof upstreamRange !== "string" || !validRange(upstreamRange)) {
						failures.push(
							`baseline package.json dependency ${dep} must be a valid semver range; found ${JSON.stringify(upstreamRange)}`,
						);
					} else if (localVer && !satisfies(localVer, upstreamRange)) {
						failures.push(
							`local dependency ${dep}@${localVer} does not satisfy upstream coding-agent range ${upstreamRange}`,
						);
					}
				}
			}
		}
	}
}

export function parseNameStatus(output) {
	if (!output) return [];
	const fields = output.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const entries = [];
	for (let i = 0; i < fields.length; i += 2) {
		if (fields[i + 1] === undefined) {
			throw new Error("git diff --name-status returned an incomplete NUL-delimited entry");
		}
		entries.push({ status: fields[i], path: fields[i + 1] });
	}
	return entries;
}

export function collectWorktreeEntries(sourceTree, failures, git) {
	const entries = new Map();
	const diffOutput = git("diff", "--name-status", "-z", "--no-renames", sourceTree, "--");
	for (const entry of parseNameStatus(diffOutput)) {
		if (!["A", "M", "D", "T"].includes(entry.status)) {
			failures.push(`unsupported worktree status "${entry.status}" for path: ${entry.path}`);
		}
		entries.set(entry.path, entry);
	}
	const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
	for (const path of untracked.split("\0")) {
		if (!path) continue;
		if (entries.has(path)) {
			failures.push(
				`path appears in both the baseline-worktree diff and git ls-files --others: ${path}; reconcile tracked and untracked status`,
			);
		} else {
			entries.set(path, { status: "A", path });
		}
	}
	return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function writeLine(stream, value) {
	stream.write(`${value}\n`);
}

function printFailures(failures, stderr) {
	if (failures.length === 0) return;
	writeLine(stderr, "Upstream baseline checks failed:");
	for (const f of failures) writeLine(stderr, `  - ${f}`);
}

export function runDiffUpstream({
	root = resolve(import.meta.dirname, ".."),
	args = process.argv.slice(2),
	stdout = process.stdout,
	stderr = process.stderr,
} = {}) {
	const knownFlags = new Set(["--check"]);
	if (args.some((arg) => !knownFlags.has(arg)) || args.length > 1) {
		writeLine(stderr, usage);
		return 2;
	}

	const isCheck = args[0] === "--check";
	const { git, tryGit } = createGit(root);

	const failures = [];
	const warnings = [];

	const manifest = readJsonFile(join(root, "maintainers", "upstream.json"), "maintainers/upstream.json", failures);
	if (manifest !== undefined) {
		failures.push(...validateManifest(manifest));
	}
	if (failures.length > 0) {
		printFailures(failures, stderr);
		return 1;
	}

	const upstreamPackage = verifyBaseline(manifest, failures, warnings, tryGit);
	verifyRuntimeDependencies(upstreamPackage, manifest, failures, root);
	if (failures.length > 0) {
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		printFailures(failures, stderr);
		return 1;
	}

	const entries = collectWorktreeEntries(manifest.sourceTree, failures, git);
	if (failures.length > 0) {
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		printFailures(failures, stderr);
		return 1;
	}

	const modified = entries.filter((e) => e.status === "M" || e.status === "T");
	const additions = entries.filter((e) => e.status === "A");
	const dropped = entries.filter((e) => e.status === "D");

	// The ledger must cover every modified or dropped upstream path (M/T/D).
	// Additions are distribution-local and listed without registration.
	const deltasPath = join(root, "maintainers", "deltas.json");
	const ledgerFailures = [];
	let deltaEntries = [];
	if (existsSync(deltasPath)) {
		const deltasJson = readJsonFile(deltasPath, "maintainers/deltas.json", ledgerFailures);
		if (deltasJson !== undefined) {
			deltaEntries = validateDeltas(deltasJson, root, ledgerFailures);
		}
	} else {
		ledgerFailures.push("maintainers/deltas.json is missing; register upstream deviations there");
	}

	const ledgerScope = [...modified, ...dropped];
	const unregistered = ledgerScope.filter((entry) => findDelta(deltaEntries, entry.path) === undefined);
	const scopePaths = new Set(ledgerScope.map((entry) => entry.path));
	const stale = deltaEntries.filter((entry) =>
		entry.path.endsWith("/")
			? !ledgerScope.some((scoped) => scoped.path.startsWith(entry.path))
			: !scopePaths.has(entry.path),
	);

	for (const w of warnings) writeLine(stderr, `warning: ${w}`);

	if (isCheck) {
		for (const f of ledgerFailures) writeLine(stderr, `  - ${f}`);
		for (const entry of unregistered) {
			writeLine(stderr, `  - unregistered upstream deviation: ${entry.status} ${entry.path}`);
		}
		for (const entry of stale) {
			writeLine(stderr, `  - stale delta entry (no matching worktree deviation): ${entry.path}`);
		}
		writeLine(
			stdout,
			`Verified ${entries.length} worktree differences against ${manifest.tag}: ${modified.length} modified upstream (M/T), ${additions.length} distribution-local additions (A), ${dropped.length} dropped upstream (D), ${deltaEntries.length} registered deltas.`,
		);
		return ledgerFailures.length > 0 || unregistered.length > 0 || stale.length > 0 ? 1 : 0;
	}

	for (const f of ledgerFailures) writeLine(stderr, `warning: ${f}`);

	// Paths covered by a directory ledger entry fold into one annotated line
	// per directory so the report stays scannable at full worktree width.
	const formatGroupLines = (groupEntries) => {
		const lines = [];
		const foldedByDir = new Map();
		for (const entry of groupEntries) {
			const delta = findDelta(deltaEntries, entry.path);
			if (delta?.path.endsWith("/")) {
				let folded = foldedByDir.get(delta.path);
				if (folded === undefined) {
					folded = { delta, statuses: new Set(), count: 0 };
					foldedByDir.set(delta.path, folded);
					lines.push(folded);
				}
				folded.statuses.add(entry.status);
				folded.count += 1;
				continue;
			}
			const annotation = delta === undefined ? "" : `  [${delta.category}] ${delta.intent}`;
			lines.push(`  ${entry.status} ${entry.path}${annotation}`);
		}
		return lines.map((line) => {
			if (typeof line === "string") return line;
			const status = [...line.statuses].sort().join("/");
			const noun = line.count === 1 ? "file" : "files";
			return `  ${status} ${line.delta.path} (${line.count} ${noun})  [${line.delta.category}] ${line.delta.intent}`;
		});
	};

	writeLine(
		stdout,
		`Upstream baseline: ${manifest.tag} ${manifest.sourceSubtree} (tree ${manifest.sourceTree.slice(0, 12)})`,
	);
	writeLine(
		stdout,
		"Compared against: current worktree (tracked staged/unstaged changes and nonignored untracked files)",
	);
	writeLine(stdout, "");
	writeLine(stdout, `Worktree differences against upstream baseline (${entries.length} total):`);
	writeLine(stdout, `  ${String(modified.length).padStart(4)} modified upstream files (M/T)`);
	writeLine(stdout, `  ${String(additions.length).padStart(4)} distribution-local additions (A)`);
	writeLine(stdout, `  ${String(dropped.length).padStart(4)} dropped upstream files (D)`);
	writeLine(stdout, `  ${String(deltaEntries.length).padStart(4)} registered deltas`);

	const groups = [
		["Modified upstream files (M/T)", modified],
		["Distribution-local additions (A)", additions],
		["Dropped upstream files (D)", dropped],
	];

	for (const [title, groupEntries] of groups) {
		if (groupEntries.length === 0) continue;
		writeLine(stdout, "");
		writeLine(stdout, `${title}:`);
		for (const line of formatGroupLines(groupEntries)) {
			writeLine(stdout, line);
		}
	}

	if (unregistered.length > 0) {
		writeLine(stdout, "");
		writeLine(stdout, "Unregistered upstream deviations (add to maintainers/deltas.json):");
		for (const entry of unregistered) {
			writeLine(stdout, `  ${entry.status} ${entry.path}`);
		}
	}

	if (stale.length > 0) {
		writeLine(stdout, "");
		writeLine(stdout, "Stale delta entries (registered path no longer deviates):");
		for (const entry of stale) {
			writeLine(stdout, `  ${entry.path}`);
		}
	}

	return 0;
}

const mainPath = process.argv[1] && resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
const isMain =
	mainPath &&
	(process.platform === "win32" ? mainPath.toLowerCase() === modulePath.toLowerCase() : mainPath === modulePath);

if (isMain) {
	process.exitCode = runDiffUpstream();
}
