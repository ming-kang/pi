#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prerelease, satisfies, valid, validRange } from "semver";

const upstreamDependencyNames = [
	"@earendil-works/chord",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-client",
	"@earendil-works/pi-protocol",
	"@earendil-works/pi-server",
	"@earendil-works/pi-tui",
];
// This list identifies consumed upstream libraries, not their installation scope.
// v0.85.0 omitted pi-server's range; newer baselines declare it for source development.
const legacyUndeclaredDependencies = ["@earendil-works/pi-server"];
const manifestKeys = ["repository", "tag", "commit", "sourceSubtree", "sourceTree"];
const ledgerPath = "maintainers/concerns.json";
const concernRequiredKeys = ["id", "why", "paths"];
const concernAllowedKeys = [...concernRequiredKeys, "tests", "watch"];
const claimAllowedKeys = ["path", "rewrite"];

// Form and conflict-surface metrics cover runtime source only; documentation,
// tests, and packaging files are merged by hand.
export const MEASURED_SCOPE = "src/";
// A modified path is a rewrite once it deletes or re-indents more upstream
// lines than a thin patch needs. These thresholds are a policy choice.
export const MAX_PATCH_DELETIONS = 8;
export const MAX_PATCH_REINDENT = 10;
export const DEFAULT_RISK_WINDOW_DAYS = 120;

const usage = `Usage: node scripts/diff-upstream.mjs [--check [--staged] | --risk [--window <days>] | --target <tag> | --apply <tag>]

Compares the current worktree against the recorded upstream baseline
in maintainers/upstream.json, annotated with the concern ledger in
maintainers/concerns.json.

  (no flag)        print the deterministic full classification report with conflict-surface metrics
  --check          verify baseline, dependencies, and ledger rules and print a concise count summary
  --staged         with --check, verify the index that will be committed
  --risk           rank modified source paths by conflict surface times upstream touches
  --window <days>  with --risk, count upstream touches over this many days before the baseline (default ${DEFAULT_RISK_WINDOW_DAYS})
  --target <tag>   classify upstream changes from the baseline to a release tag against the ledger
  --apply <tag>    three-way merge those upstream changes into a clean worktree and advance the baseline`;

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

function isValidLedgerPath(value) {
	return (
		isNonEmptyString(value) &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value === posix.normalize(value) &&
		!value.split("/").some((part) => part === "" || part === "." || part === "..")
	);
}

const concernIdPattern = /^[a-z\d]+(?:-[a-z\d]+)*$/;

/**
 * Validate maintainers/concerns.json and return its flattened path claims.
 * A claim path with a trailing "/" registers a whole directory prefix; all
 * other claims register one exact file. Several concerns may claim one path.
 */
export function validateConcerns(ledger, root, failures, testExists = (path) => existsSync(join(root, path))) {
	if (
		!isPlainObject(ledger) ||
		ledger.version !== 2 ||
		!Array.isArray(ledger.concerns) ||
		Object.keys(ledger).length !== 2
	) {
		failures.push(`${ledgerPath} must be an object with "version": 2 and a "concerns" array`);
		return [];
	}
	const claims = [];
	const seenIds = new Set();
	for (const [index, concern] of ledger.concerns.entries()) {
		let location = `${ledgerPath} concern ${index}`;
		if (!isPlainObject(concern)) {
			failures.push(`${location} must be an object`);
			continue;
		}
		if (typeof concern.id === "string") location = `${ledgerPath} concern "${concern.id}"`;
		for (const key of concernRequiredKeys) {
			if (!Object.hasOwn(concern, key)) failures.push(`${location} is missing required key "${key}"`);
		}
		for (const key of Object.keys(concern)) {
			if (!concernAllowedKeys.includes(key)) failures.push(`${location} has unexpected key "${key}"`);
		}
		if (typeof concern.id !== "string" || !concernIdPattern.test(concern.id)) {
			failures.push(`${location} id must be kebab-case`);
		} else if (seenIds.has(concern.id)) {
			failures.push(`${ledgerPath} has a duplicate concern id "${concern.id}"`);
		}
		seenIds.add(concern.id);
		if (!isNonEmptyString(concern.why)) {
			failures.push(`${location} why must be a non-empty string`);
		}
		if (Object.hasOwn(concern, "watch") && !isNonEmptyString(concern.watch)) {
			failures.push(`${location} watch must be a non-empty string`);
		}
		if (Object.hasOwn(concern, "tests")) {
			if (!Array.isArray(concern.tests) || concern.tests.some((test) => !isNonEmptyString(test))) {
				failures.push(`${location} tests must be an array of repository-relative paths`);
			} else {
				for (const test of concern.tests) {
					if (!testExists(test)) {
						failures.push(`${location} references a test path that does not exist: ${test}`);
					}
				}
			}
		}
		if (!Array.isArray(concern.paths) || concern.paths.length === 0) {
			failures.push(`${location} paths must be a non-empty array`);
			continue;
		}
		const seenPaths = new Set();
		for (const claim of concern.paths) {
			if (!isPlainObject(claim)) {
				failures.push(`${location} paths entries must be objects`);
				continue;
			}
			for (const key of Object.keys(claim)) {
				if (!claimAllowedKeys.includes(key)) {
					failures.push(`${location} path ${JSON.stringify(claim.path)} has unexpected key "${key}"`);
				}
			}
			const isPrefix = typeof claim.path === "string" && claim.path.endsWith("/");
			if (!isValidLedgerPath(isPrefix ? claim.path.slice(0, -1) : claim.path)) {
				failures.push(
					`${location} path ${JSON.stringify(claim.path)} must be a normalized repository-relative POSIX path`,
				);
				continue;
			}
			if (seenPaths.has(claim.path)) {
				failures.push(`${location} claims "${claim.path}" more than once`);
			}
			seenPaths.add(claim.path);
			if (Object.hasOwn(claim, "rewrite") && !isNonEmptyString(claim.rewrite)) {
				failures.push(`${location} path "${claim.path}" rewrite must be a non-empty string`);
			}
			claims.push({
				concern: typeof concern.id === "string" ? concern.id : `#${index}`,
				path: claim.path,
				rewrite: claim.rewrite,
			});
		}
	}
	return claims;
}

function claimMatches(claim, path) {
	return claim.path === path || (claim.path.endsWith("/") && path.startsWith(claim.path));
}

/** Every claim on a path: its exact file claims and all enclosing directory claims. */
export function findClaims(claims, path) {
	return claims.filter((claim) => claimMatches(claim, path));
}

function concernIds(claims) {
	return [...new Set(claims.map((claim) => claim.concern))].sort().join(", ");
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

function verifyUpstreamDependencies(upstreamPackage, manifest, failures, readJson) {
	const packageJson = readJson("package.json", failures);
	const shrinkwrap = readJson("npm-shrinkwrap.json", failures);

	const localVersions = {};
	if (packageJson !== undefined) {
		if (!isPlainObject(packageJson)) {
			failures.push("package.json must be a JSON object");
		} else if (!isPlainObject(packageJson.dependencies)) {
			failures.push("package.json.dependencies must be an object");
		} else {
			for (const dep of upstreamDependencyNames) {
				const ver = packageJson.dependencies[dep] ?? packageJson.devDependencies?.[dep];
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
					for (const dep of upstreamDependencyNames) {
						const rootSpec = rootPkg.dependencies[dep] ?? rootPkg.devDependencies?.[dep];
						if (localVersions[dep] && rootSpec !== localVersions[dep]) {
							failures.push(
								`npm-shrinkwrap.json root spec for ${dep} (${String(rootSpec)}) does not match package.json (${localVersions[dep]})`,
							);
						}
					}
				}

				for (const dep of upstreamDependencyNames) {
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
				for (const dep of upstreamDependencyNames) {
					const localVer = localVersions[dep];
					const upstreamRange = upstreamPackage.dependencies[dep] ?? upstreamPackage.devDependencies?.[dep];
					if (upstreamRange === undefined && legacyUndeclaredDependencies.includes(dep)) {
						continue;
					}
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

function gitDiffArgs(staged) {
	return [
		"-c",
		"core.quotePath=false",
		"diff",
		...(staged ? ["--cached"] : []),
		"--no-renames",
		"--no-color",
		"--no-ext-diff",
		"--diff-algorithm=myers",
		"--src-prefix=a/",
		"--dst-prefix=b/",
	];
}

function parseNumstat(output) {
	const counts = new Map();
	for (const record of output.split("\0")) {
		const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
		if (!match || match[1] === "-") continue;
		counts.set(match[3], { additions: Number(match[1]), deletions: Number(match[2]) });
	}
	return counts;
}

/** Count the hunks of each file in a unified diff. */
export function parseUnifiedDiff(output) {
	const files = new Map();
	let current;
	for (const line of output.split("\n")) {
		if (line.startsWith("diff --git ")) {
			current = undefined;
		} else if (current === undefined && line.startsWith("+++ ")) {
			const target = line.slice(4).replace(/\t$/, "");
			current = { hunks: 0 };
			files.set(target.startsWith("b/") ? target.slice(2) : target, current);
		} else if (current && line.startsWith("@@")) {
			current.hunks += 1;
		}
	}
	return files;
}

export function classifyForm(path, { deletions, reindent }) {
	if (!path.startsWith(MEASURED_SCOPE)) return undefined;
	return deletions > MAX_PATCH_DELETIONS || reindent > MAX_PATCH_REINDENT ? "rewrite" : "patch";
}

/**
 * Measure every modified upstream path (M/T) against the baseline tree. Only
 * paths under MEASURED_SCOPE receive a form.
 */
export function measureModified(sourceTree, staged, git) {
	const base = [...gitDiffArgs(staged), "--diff-filter=MT"];
	const numstat = parseNumstat(git(...base, "--numstat", "-z", sourceTree, "--"));
	const semantic = parseNumstat(git(...base, "-w", "--numstat", "-z", sourceTree, "--"));
	const patches = parseUnifiedDiff(git(...base, sourceTree, "--"));
	const measured = new Map();
	for (const [path, { additions, deletions }] of numstat) {
		const surface = additions + deletions;
		const whitespaceFree = semantic.get(path);
		const reindent = Math.max(
			0,
			surface - (whitespaceFree ? whitespaceFree.additions + whitespaceFree.deletions : 0),
		);
		const patch = patches.get(path) ?? { hunks: 0 };
		measured.set(path, {
			path,
			surface,
			deletions,
			reindent,
			hunks: patch.hunks,
			form: classifyForm(path, { deletions, reindent }),
		});
	}
	return measured;
}

/**
 * Count upstream commits touching each measured source path over the window
 * ending at the baseline commit. Returns undefined when that history is not
 * available locally; the commit hook never fetches it.
 */
export function countUpstreamTouches(manifest, windowDays, tryGit) {
	if (tryGit("cat-file", "-t", manifest.commit) !== "commit") return undefined;
	const committedAt = Number(tryGit("show", "-s", "--format=%ct", manifest.commit));
	if (!Number.isFinite(committedAt)) return undefined;
	const end = new Date(committedAt * 1000);
	const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
	const prefix = `${manifest.sourceSubtree}/`;
	const log = tryGit(
		"-c",
		"core.quotePath=false",
		"log",
		"--no-renames",
		"--format=",
		"--name-only",
		`--since=${start.toISOString()}`,
		manifest.commit,
		"--",
		`${prefix}${MEASURED_SCOPE}`,
	);
	if (log === undefined) return undefined;
	const counts = new Map();
	for (const line of log.split("\n")) {
		if (!line.startsWith(prefix)) continue;
		const path = line.slice(prefix.length);
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return { start, end, counts };
}

function summarizeSurface(measured) {
	const summary = { rewrite: { files: 0, surface: 0 }, patch: { files: 0, surface: 0 } };
	for (const metrics of measured.values()) {
		if (metrics.form === undefined) continue;
		summary[metrics.form].files += 1;
		summary[metrics.form].surface += metrics.surface;
	}
	return summary;
}

/**
 * Apply the rewrite-reason rule. It only depends on the baseline diff, so it
 * runs inside the commit hook without network access.
 */
export function checkClaimRules(claims, measured) {
	const failures = [];
	for (const metrics of measured.values()) {
		if (metrics.form !== "rewrite") continue;
		if (!findClaims(claims, metrics.path).some((claim) => claim.rewrite !== undefined)) {
			failures.push(
				`${metrics.path} measures as rewrite (${metrics.deletions} deletions, ${metrics.reindent} re-indented lines); add a rewrite reason to a claiming concern or thin the patch`,
			);
		}
	}
	for (const claim of claims) {
		if (claim.rewrite === undefined) continue;
		const rewrites = [...measured.values()].some(
			(metrics) => metrics.form === "rewrite" && claimMatches(claim, metrics.path),
		);
		if (!rewrites) {
			failures.push(
				`concern "${claim.concern}" gives a rewrite reason for ${claim.path}, which no longer measures as rewrite; remove it`,
			);
		}
	}
	return failures;
}

function writeLine(stream, value) {
	stream.write(`${value}\n`);
}

function printFailures(failures, stderr) {
	if (failures.length === 0) return;
	writeLine(stderr, "Upstream baseline checks failed:");
	for (const f of failures) writeLine(stderr, `  - ${f}`);
}

/** Load and validate the concern ledger, reporting problems into failures. */
function loadClaims(root, failures, readJson, stagedPaths) {
	if (!(stagedPaths ? stagedPaths.has(ledgerPath) : existsSync(join(root, ledgerPath)))) {
		failures.push(`${ledgerPath} is missing; register upstream deviations there`);
		return [];
	}
	const ledger = readJson(ledgerPath, failures);
	if (ledger === undefined) return [];
	return validateConcerns(ledger, root, failures, stagedPaths ? (path) => stagedPaths.has(path) : undefined);
}

/**
 * Format one report group. Paths claimed only through a directory fold into
 * a single annotated line so the report stays scannable.
 */
function formatGroupLines(groupEntries, claims) {
	const lines = [];
	const foldedByDir = new Map();
	for (const entry of groupEntries) {
		const matching = findClaims(claims, entry.path);
		if (matching.length > 0 && matching.every((claim) => claim.path.endsWith("/"))) {
			const dir = matching.reduce(
				(longest, claim) => (claim.path.length > longest.length ? claim.path : longest),
				"",
			);
			let folded = foldedByDir.get(dir);
			if (folded === undefined) {
				folded = {
					dir,
					concerns: concernIds(claims.filter((claim) => claim.path === dir)),
					statuses: new Set(),
					count: 0,
				};
				foldedByDir.set(dir, folded);
				lines.push(folded);
			}
			folded.statuses.add(entry.status);
			folded.count += 1;
			continue;
		}
		const annotation = matching.length === 0 ? "" : `  [${concernIds(matching)}]`;
		lines.push(`  ${entry.status} ${entry.path}${annotation}`);
	}
	return lines.map((line) => {
		if (typeof line === "string") return line;
		const status = [...line.statuses].sort().join("/");
		const noun = line.count === 1 ? "file" : "files";
		return `  ${status} ${line.dir} (${line.count} ${noun})  [${line.concerns}]`;
	});
}

function printGroups(groups, claims, stdout) {
	for (const [title, groupEntries] of groups) {
		if (groupEntries.length === 0) continue;
		writeLine(stdout, "");
		writeLine(stdout, `${title}:`);
		for (const line of formatGroupLines(groupEntries, claims)) {
			writeLine(stdout, line);
		}
	}
}

function formatTable(header, rows) {
	const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => String(row[column]).length)));
	const format = (row) =>
		row
			.map((cell, column) => (column === row.length - 1 ? String(cell) : String(cell).padStart(widths[column])))
			.join("  ");
	return [format(header), ...rows.map(format)].map((line) => `  ${line}`);
}

function printSurface(measured, stdout) {
	const scoped = [...measured.values()].filter((metrics) => metrics.form !== undefined);
	scoped.sort((a, b) => b.surface - a.surface || (a.path < b.path ? -1 : 1));
	const summary = summarizeSurface(measured);
	writeLine(stdout, "");
	writeLine(
		stdout,
		`Conflict surface of modified ${MEASURED_SCOPE} paths: rewrite ${summary.rewrite.surface} lines in ${summary.rewrite.files} files, patch ${summary.patch.surface} lines in ${summary.patch.files} files`,
	);
	for (const line of formatTable(
		["form", "surface", "reindent", "hunks", "path"],
		scoped.map((metrics) => [metrics.form, metrics.surface, metrics.reindent, metrics.hunks, metrics.path]),
	)) {
		writeLine(stdout, line);
	}
}

function printRisk(manifest, measured, touches, windowDays, stdout, stderr) {
	const scoped = [...measured.values()].filter((metrics) => metrics.form !== undefined);
	const rows = scoped.map((metrics) => {
		const count = touches?.counts.get(metrics.path) ?? 0;
		return { metrics, touches: touches ? count : undefined, risk: touches ? count * metrics.surface : undefined };
	});
	rows.sort(
		(a, b) =>
			(b.risk ?? 0) - (a.risk ?? 0) ||
			b.metrics.surface - a.metrics.surface ||
			(a.metrics.path < b.metrics.path ? -1 : 1),
	);
	const summary = summarizeSurface(measured);
	writeLine(
		stdout,
		`Upstream baseline: ${manifest.tag} ${manifest.sourceSubtree} (tree ${manifest.sourceTree.slice(0, 12)})`,
	);
	if (touches) {
		const day = (date) => date.toISOString().slice(0, 10);
		writeLine(stdout, `Touch window: ${windowDays} days (${day(touches.start)}..${day(touches.end)})`);
	} else {
		writeLine(
			stderr,
			`warning: upstream history for ${manifest.commit.slice(0, 12)} is unavailable locally; touches and risk are n/a (fetch ${manifest.tag} to measure them)`,
		);
	}
	writeLine(stdout, "");
	for (const line of formatTable(
		["risk", "touches", "surface", "reindent", "hunks", "form", "path"],
		rows.map(({ metrics, touches: count, risk }) => [
			risk ?? "n/a",
			count ?? "n/a",
			metrics.surface,
			metrics.reindent,
			metrics.hunks,
			metrics.form,
			metrics.path,
		]),
	)) {
		writeLine(stdout, line);
	}
	const totalRisk = touches ? rows.reduce((sum, row) => sum + row.risk, 0) : "n/a";
	writeLine(stdout, "");
	writeLine(stdout, `rewriteSurface: ${summary.rewrite.surface}`);
	writeLine(stdout, `risk: ${totalRisk}`);
}

function readBlob(root, spec) {
	return execFileSync("git", ["cat-file", "blob", spec], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Three-way merge the upstream changes from the baseline tree to the target
 * tree into the worktree, one path at a time with git merge-file. Paths the
 * distribution dropped stay dropped, and an upstream deletion of a locally
 * changed path is left for review. Returns one { action, path } per change.
 */
export function applyUpstreamChanges(root, baseTree, targetTree, git) {
	const scratch = mkdtempSync(join(tmpdir(), "pi-apply-"));
	const results = [];
	try {
		const changes = parseNameStatus(git("diff", "--name-status", "-z", "--no-renames", baseTree, targetTree));
		for (const { status, path } of changes) {
			const local = join(root, path);
			const exists = existsSync(local);
			const base = status === "A" ? Buffer.alloc(0) : readBlob(root, `${baseTree}:${path}`);
			if (status === "D") {
				if (!exists) continue;
				if (readFileSync(local).equals(base)) {
					rmSync(local);
					results.push({ action: "deleted", path });
				} else {
					results.push({ action: "conflict", path, detail: "deleted upstream, changed locally" });
				}
				continue;
			}
			const theirs = readBlob(root, `${targetTree}:${path}`);
			if (!exists) {
				if (status === "A") {
					mkdirSync(dirname(local), { recursive: true });
					writeFileSync(local, theirs);
					results.push({ action: "added", path });
				} else {
					results.push({ action: "skipped", path, detail: "dropped locally" });
				}
				continue;
			}
			const ours = readFileSync(local);
			if (ours.equals(theirs)) continue;
			if ([base, ours, theirs].some((content) => content.subarray(0, 8000).includes(0))) {
				results.push({ action: "conflict", path, detail: "binary; distribution version kept" });
				continue;
			}
			const basePath = join(scratch, "base");
			const theirsPath = join(scratch, "theirs");
			writeFileSync(basePath, base);
			writeFileSync(theirsPath, theirs);
			let conflicts = 0;
			try {
				execFileSync(
					"git",
					["merge-file", "-L", "distribution", "-L", "baseline", "-L", "upstream", local, basePath, theirsPath],
					{ cwd: root, stdio: "pipe" },
				);
			} catch (error) {
				conflicts = typeof error?.status === "number" && error.status > 0 ? error.status : -1;
			}
			if (conflicts > 0) {
				results.push({ action: "conflict", path, detail: `${conflicts} conflicting hunk(s)` });
			} else if (conflicts < 0) {
				results.push({ action: "conflict", path, detail: "git merge-file failed; distribution version kept" });
			} else {
				results.push({ action: "merged", path });
			}
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return results;
}

function parseArgs(args) {
	const options = {
		check: false,
		staged: false,
		risk: false,
		windowDays: undefined,
		targetTag: undefined,
		applyTag: undefined,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--check" && !options.check) {
			options.check = true;
		} else if (arg === "--staged" && !options.staged) {
			options.staged = true;
		} else if (arg === "--risk" && !options.risk) {
			options.risk = true;
		} else if (arg === "--window" && options.windowDays === undefined && /^[1-9]\d*$/.test(args[i + 1] ?? "")) {
			options.windowDays = Number(args[i + 1]);
			i += 1;
		} else if (arg === "--target" && options.targetTag === undefined && typeof args[i + 1] === "string") {
			options.targetTag = args[i + 1];
			i += 1;
		} else if (arg === "--apply" && options.applyTag === undefined && typeof args[i + 1] === "string") {
			options.applyTag = args[i + 1];
			i += 1;
		} else {
			return undefined;
		}
	}
	const modes = [options.check, options.risk, options.targetTag !== undefined, options.applyTag !== undefined].filter(
		Boolean,
	).length;
	if (modes > 1 || (options.staged && !options.check) || (options.windowDays !== undefined && !options.risk)) {
		return undefined;
	}
	return options;
}

export function runDiffUpstream({
	root = resolve(import.meta.dirname, ".."),
	args = process.argv.slice(2),
	stdout = process.stdout,
	stderr = process.stderr,
} = {}) {
	const options = parseArgs(args);
	if (options === undefined) {
		writeLine(stderr, usage);
		return 2;
	}
	const { check: isCheck, staged, risk: isRisk, targetTag, applyTag } = options;
	const releaseTag = targetTag ?? applyTag;
	if (releaseTag !== undefined && (!releaseTag.startsWith("v") || !isStableSemver(releaseTag.slice(1)))) {
		writeLine(stderr, `${targetTag ? "--target" : "--apply"} requires an exact stable release tag (v<semver>)`);
		return 2;
	}

	const { git, tryGit } = createGit(root);
	const stagedPaths = staged ? new Set(git("ls-files", "-z").split("\0")) : undefined;
	const readJson = (path, errors) => {
		if (!staged) return readJsonFile(join(root, path), path, errors);
		const contents = tryGit("show", `:${path}`);
		if (contents === undefined) {
			errors.push(`${path} is missing from the index; stage the intended file before committing`);
			return undefined;
		}
		return parseJson(contents, `staged ${path}`, errors);
	};

	const failures = [];
	const warnings = [];

	const manifest = readJson("maintainers/upstream.json", failures);
	if (manifest !== undefined) {
		failures.push(...validateManifest(manifest));
	}
	if (failures.length > 0) {
		printFailures(failures, stderr);
		return 1;
	}

	const upstreamPackage = verifyBaseline(manifest, failures, warnings, tryGit);
	if (releaseTag === undefined) {
		verifyUpstreamDependencies(upstreamPackage, manifest, failures, readJson);
	}
	if (failures.length > 0) {
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		printFailures(failures, stderr);
		return 1;
	}

	// Target mode classifies the upstream release diff against both the ledger
	// and additions already owned by the clean HEAD tree. It never inspects
	// staged, unstaged, or untracked worktree state.
	if (releaseTag !== undefined) {
		const targetCommit = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}^{commit}`);
		if (!targetCommit) {
			failures.push(`target tag ${releaseTag} is not available locally; run git fetch upstream --tags`);
		}
		const targetTree = targetCommit
			? tryGit("rev-parse", "--verify", "--quiet", `${targetCommit}:${manifest.sourceSubtree}`)
			: undefined;
		if (targetCommit && !targetTree) {
			failures.push(`target tag ${releaseTag} does not contain source subtree ${manifest.sourceSubtree}`);
		}
		const headTree = tryGit("rev-parse", "--verify", "--quiet", "HEAD^{tree}");
		if (!headTree) {
			failures.push("HEAD does not resolve to a tree; commit the distribution before target triage");
		}
		if (applyTag !== undefined && tryGit("status", "--porcelain", "--untracked-files=no")) {
			failures.push("the worktree has uncommitted tracked changes; commit or set them aside before --apply");
		}
		if (failures.length > 0) {
			for (const w of warnings) writeLine(stderr, `warning: ${w}`);
			printFailures(failures, stderr);
			return 1;
		}

		// Apply mode merges the release into the worktree and advances the
		// baseline, so the ordinary check then measures against the new release.
		if (applyTag !== undefined) {
			for (const w of warnings) writeLine(stderr, `warning: ${w}`);
			const results = applyUpstreamChanges(root, manifest.sourceTree, targetTree, git);
			const next = { ...manifest, tag: applyTag, commit: targetCommit, sourceTree: targetTree };
			writeFileSync(
				join(root, "maintainers", "upstream.json"),
				`${JSON.stringify(next, null, "	")}
`,
			);
			const counts = {};
			for (const { action, path, detail } of results) {
				counts[action] = (counts[action] ?? 0) + 1;
				writeLine(stdout, `  ${action} ${path}${detail ? ` (${detail})` : ""}`);
			}
			const summary = ["merged", "added", "deleted", "skipped", "conflict"]
				.map((action) => `${counts[action] ?? 0} ${action}`)
				.join(", ");
			writeLine(stdout, "");
			writeLine(
				stdout,
				`Applied ${manifest.tag} -> ${applyTag}: ${summary}. maintainers/upstream.json now records ${applyTag}.`,
			);
			return counts.conflict ? 1 : 0;
		}

		const ledgerFailures = [];
		const claims = loadClaims(root, ledgerFailures, readJson, stagedPaths);
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		if (ledgerFailures.length > 0) {
			printFailures(ledgerFailures, stderr);
			return 1;
		}

		const localAdditionPaths = new Set(
			parseNameStatus(git("diff", "--name-status", "-z", "--no-renames", manifest.sourceTree, headTree))
				.filter((entry) => entry.status === "A")
				.map((entry) => entry.path),
		);
		const changes = parseNameStatus(
			git("diff", "--name-status", "-z", "--no-renames", manifest.sourceTree, targetTree),
		);
		const removed = changes.filter((entry) => entry.status === "D");
		const surviving = changes.filter((entry) => entry.status !== "D");
		const isClaimed = (entry) => findClaims(claims, entry.path).length > 0;
		const registeredCollisions = surviving.filter(isClaimed);
		const additionCollisions = surviving.filter((entry) => !isClaimed(entry) && localAdditionPaths.has(entry.path));
		const clean = surviving.filter((entry) => !isClaimed(entry) && !localAdditionPaths.has(entry.path));

		writeLine(
			stdout,
			`Upstream baseline: ${manifest.tag} ${manifest.sourceSubtree} (tree ${manifest.sourceTree.slice(0, 12)})`,
		);
		writeLine(stdout, `Target: ${targetTag} ${manifest.sourceSubtree} (tree ${targetTree.slice(0, 12)})`);
		writeLine(stdout, "");
		writeLine(stdout, `Upstream changes from ${manifest.tag} to ${targetTag} (${changes.length} total):`);
		writeLine(
			stdout,
			`  ${String(registeredCollisions.length).padStart(4)} touching registered deviations (re-review each)`,
		);
		writeLine(
			stdout,
			`  ${String(additionCollisions.length).padStart(4)} colliding with fork-owned additions (re-review each)`,
		);
		writeLine(stdout, `  ${String(clean.length).padStart(4)} clear of fork deviations (adoption candidates)`);
		writeLine(stdout, `  ${String(removed.length).padStart(4)} removed upstream`);

		printGroups(
			[
				["Changes touching registered deviations", registeredCollisions],
				["Changes colliding with fork-owned additions", additionCollisions],
				["Changes clear of fork deviations", clean],
				["Removed upstream", removed],
			],
			claims,
			stdout,
		);
		return 0;
	}

	const entries = staged
		? parseNameStatus(git("diff", "--cached", "--name-status", "-z", "--no-renames", manifest.sourceTree, "--"))
		: collectWorktreeEntries(manifest.sourceTree, failures, git);
	if (failures.length > 0) {
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		printFailures(failures, stderr);
		return 1;
	}
	const measured = measureModified(manifest.sourceTree, staged, git);

	if (isRisk) {
		for (const w of warnings) writeLine(stderr, `warning: ${w}`);
		const windowDays = options.windowDays ?? DEFAULT_RISK_WINDOW_DAYS;
		const touches = countUpstreamTouches(manifest, windowDays, tryGit);
		printRisk(manifest, measured, touches, windowDays, stdout, stderr);
		return 0;
	}

	const modified = entries.filter((e) => e.status === "M" || e.status === "T");
	const additions = entries.filter((e) => e.status === "A");
	const dropped = entries.filter((e) => e.status === "D");

	// The ledger must cover every modified or dropped upstream path (M/T/D).
	// Additions are distribution-local and listed without registration.
	const ledgerFailures = [];
	const claims = loadClaims(root, ledgerFailures, readJson, stagedPaths);

	const ledgerScope = [...modified, ...dropped];
	const unregistered = ledgerScope.filter((entry) => findClaims(claims, entry.path).length === 0);
	const stale = claims.filter((claim) => !ledgerScope.some((entry) => claimMatches(claim, entry.path)));
	const ruleFailures = ledgerFailures.length === 0 ? checkClaimRules(claims, measured) : [];
	const concernCount = new Set(claims.map((claim) => claim.concern)).size;

	for (const w of warnings) writeLine(stderr, `warning: ${w}`);

	if (isCheck) {
		for (const f of ledgerFailures) writeLine(stderr, `  - ${f}`);
		for (const entry of unregistered) {
			writeLine(stderr, `  - unregistered upstream deviation: ${entry.status} ${entry.path}`);
		}
		for (const claim of stale) {
			writeLine(
				stderr,
				`  - stale claim (no matching worktree deviation): ${claim.path} in concern "${claim.concern}"`,
			);
		}
		for (const f of ruleFailures) writeLine(stderr, `  - ${f}`);
		const summary = summarizeSurface(measured);
		writeLine(
			stdout,
			`Verified ${entries.length} ${staged ? "staged" : "worktree"} differences against ${manifest.tag}: ${modified.length} modified upstream (M/T), ${additions.length} distribution-local additions (A), ${dropped.length} dropped upstream (D), ${concernCount} registered concerns, rewrite surface ${summary.rewrite.surface} lines.`,
		);
		return ledgerFailures.length > 0 || unregistered.length > 0 || stale.length > 0 || ruleFailures.length > 0
			? 1
			: 0;
	}

	for (const f of ledgerFailures) writeLine(stderr, `warning: ${f}`);

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
	writeLine(stdout, `  ${String(concernCount).padStart(4)} registered concerns`);

	printGroups(
		[
			["Modified upstream files (M/T)", modified],
			["Distribution-local additions (A)", additions],
			["Dropped upstream files (D)", dropped],
		],
		claims,
		stdout,
	);

	printSurface(measured, stdout);

	if (unregistered.length > 0) {
		writeLine(stdout, "");
		writeLine(stdout, `Unregistered upstream deviations (add to ${ledgerPath}):`);
		for (const entry of unregistered) {
			writeLine(stdout, `  ${entry.status} ${entry.path}`);
		}
	}

	if (stale.length > 0) {
		writeLine(stdout, "");
		writeLine(stdout, "Stale claims (registered path no longer deviates):");
		for (const claim of stale) {
			writeLine(stdout, `  ${claim.path} in concern "${claim.concern}"`);
		}
	}

	if (ruleFailures.length > 0) {
		writeLine(stdout, "");
		writeLine(stdout, "Ledger rule violations:");
		for (const f of ruleFailures) writeLine(stdout, `  ${f}`);
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
