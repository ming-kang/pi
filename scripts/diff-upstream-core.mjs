#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { prerelease, satisfies, valid } from "semver";

const baselineBranch = "upstream-extract";
const runtimeDependencyNames = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"];
const baselineKeys = [
	"repository",
	"tag",
	"commit",
	"sourceSubtree",
	"sourceTree",
	"codingAgentVersion",
	"runtimeDependencies",
];
const budgetKeys = [
	"hybridPathCeiling",
	"hybridSourcePathCeiling",
	"droppedPathCeiling",
	"deltaUnitCeiling",
	"highRiskUnitCeiling",
	"privateUpstreamAssumptionCeiling",
];
const ownedKeys = ["overlays", "additions"];
const deltaKeys = ["id", "title", "disposition", "risk", "privateUpstreamAssumptions", "modified", "dropped"];
const rootKeys = ["schemaVersion", "baseline", "budget", "owned", "deltas"];
const validDispositions = new Set(["keep", "isolate", "upstream"]);
const validRisks = new Set(["low", "medium", "high"]);
const supportedStatuses = new Set(["A", "M", "D"]);

const usage = `Usage: node scripts/diff-upstream.mjs [--check | --update-baseline]

Compares the current worktree against the reviewed upstream coding-agent baseline
recorded in maintainers/upstream.json and classifies every difference as hybrid
(registered upstream file with local modifications), distribution-owned
(registered local path), or unregistered drift.

  (no flag)          print the full classification report
  --check            print only problems; exit 1 on unregistered drift,
                     stale registrations, a stale baseline cache, or a budget mismatch
  --update-baseline  create or move the ${baselineBranch} branch to the
                     root-mapped canonical upstream tree`;

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

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function checkExactKeys(value, expectedKeys, location, failures) {
	if (!isPlainObject(value)) {
		failures.push(`${location} must be an object`);
		return false;
	}
	for (const key of expectedKeys) {
		if (!Object.hasOwn(value, key)) failures.push(`${location} is missing required key ${key}`);
	}
	for (const key of Object.keys(value)) {
		if (!expectedKeys.includes(key)) failures.push(`${location} has unknown key ${key} (possible typo)`);
	}
	return true;
}

function validateString(value, location, failures) {
	if (!isNonEmptyString(value)) {
		failures.push(`${location} must be a non-empty string`);
		return false;
	}
	return true;
}

function isStableSemver(value) {
	return valid(value) === value && prerelease(value) === null;
}

export function isCanonicalPosixPath(value) {
	return (
		isNonEmptyString(value) &&
		value === value.trim() &&
		!value.startsWith("/") &&
		!value.endsWith("/") &&
		!value.includes("\\") &&
		!/[\x00-\x1f\x7f]/.test(value) &&
		!/[*!?[\]{}]/.test(value) &&
		posix.normalize(value) === value
	);
}

export function parseOwnedPattern(value) {
	if (typeof value !== "string") return undefined;
	if (value.endsWith("/**")) {
		const base = value.slice(0, -3);
		if (!isCanonicalPosixPath(base)) return undefined;
		return { base, isSubtree: true };
	}
	if (!isCanonicalPosixPath(value)) return undefined;
	return { base: value, isSubtree: false };
}

function isCanonicalGitTag(value) {
	return (
		isNonEmptyString(value) &&
		value === value.trim() &&
		!value.startsWith(".") &&
		!value.startsWith("/") &&
		!value.endsWith(".") &&
		!value.endsWith("/") &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!/[\x00-\x20\x7f~^:?*[\\]/.test(value)
	);
}

function isRepositoryOwner(value) {
	return /^[A-Za-z\d](?:[A-Za-z\d-]{0,37})$/.test(value) && !value.endsWith("-");
}

function isRepositoryName(value) {
	return /^[A-Za-z\d](?:[A-Za-z\d._-]{0,99})$/.test(value) && !value.endsWith(".");
}

export function normalizeRepository(value) {
	if (typeof value !== "string") return undefined;
	const parts = value.split("/");
	if (parts.length !== 2 || !isRepositoryOwner(parts[0]) || !isRepositoryName(parts[1])) return undefined;
	return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

export function parseRemoteNames(output) {
	return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

export function normalizeGithubRepository(remoteUrl) {
	if (typeof remoteUrl !== "string" || remoteUrl.trim() !== remoteUrl) return undefined;
	const scpLike = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
	if (scpLike) return normalizeRepository(`${scpLike[1]}/${scpLike[2]}`);
	try {
		const parsed = new URL(remoteUrl);
		if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) return undefined;
		const repository = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
		return normalizeRepository(`${parts[0]}/${repository}`);
	} catch {
		return undefined;
	}
}

function trackUnique(value, location, kind, seen, failures) {
	const firstLocation = seen.get(value);
	if (firstLocation) {
		failures.push(`${location} duplicates ${kind} ${JSON.stringify(value)} already used by ${firstLocation}`);
		return;
	}
	seen.set(value, location);
}

export function rulesOverlap(first, second) {
	if (!first.isSubtree && !second.isSubtree) return first.base === second.base;
	if (first.isSubtree && second.isSubtree) {
		return (
			first.base === second.base ||
			first.base.startsWith(`${second.base}/`) ||
			second.base.startsWith(`${first.base}/`)
		);
	}
	const subtree = first.isSubtree ? first : second;
	const exact = first.isSubtree ? second : first;
	return exact.base.startsWith(`${subtree.base}/`);
}

export function ruleMatches(rule, path) {
	return rule.isSubtree ? path.startsWith(`${rule.base}/`) : path === rule.base;
}

function validatePathArray(value, location, ruleKind, allowSubtree, paths, rules, failures) {
	if (!Array.isArray(value)) {
		failures.push(`${location} must be an array`);
		return;
	}
	for (const [index, path] of value.entries()) {
		const pathLocation = `${location}[${index}]`;
		if (!validateString(path, pathLocation, failures)) continue;
		const parsed = allowSubtree
			? parseOwnedPattern(path)
			: isCanonicalPosixPath(path)
				? { base: path, isSubtree: false }
				: undefined;
		if (!parsed) {
			const expected = allowSubtree
				? "an exact canonical POSIX path or a canonical path ending in /**"
				: "an exact canonical POSIX path without glob syntax";
			failures.push(`${pathLocation} must be ${expected}`);
			continue;
		}
		trackUnique(path, pathLocation, "path", paths, failures);
		rules.push({
			base: parsed.base,
			isSubtree: parsed.isSubtree,
			location: pathLocation,
			pattern: path,
			ruleKind,
		});
	}
}

export function validateManifest(record) {
	const failures = [];
	const rules = [];
	if (!checkExactKeys(record, rootKeys, "maintainers/upstream.json", failures)) return { failures, rules };

	if (record.schemaVersion !== 3) {
		failures.push("maintainers/upstream.json.schemaVersion must be the integer 3");
	}

	const paths = new Map();
	const unitIds = new Map();
	const unitTitles = new Map();
	const assumptions = new Map();

	if (checkExactKeys(record.baseline, baselineKeys, "baseline", failures)) {
		const { baseline } = record;
		if (
			validateString(baseline.repository, "baseline.repository", failures) &&
			!normalizeRepository(baseline.repository)
		) {
			failures.push("baseline.repository must be a canonical GitHub owner/repository pair");
		}
		if (validateString(baseline.tag, "baseline.tag", failures) && !isCanonicalGitTag(baseline.tag)) {
			failures.push("baseline.tag must be a canonical Git tag name");
		}
		for (const key of ["commit", "sourceTree"]) {
			if (validateString(baseline[key], `baseline.${key}`, failures) && !/^[0-9a-f]{40}$/.test(baseline[key])) {
				failures.push(`baseline.${key} must be a lowercase 40-hex Git object ID`);
			}
		}
		if (
			validateString(baseline.sourceSubtree, "baseline.sourceSubtree", failures) &&
			!isCanonicalPosixPath(baseline.sourceSubtree)
		) {
			failures.push("baseline.sourceSubtree must be an exact canonical POSIX path without glob syntax");
		}
		if (
			validateString(baseline.codingAgentVersion, "baseline.codingAgentVersion", failures) &&
			!isStableSemver(baseline.codingAgentVersion)
		) {
			failures.push("baseline.codingAgentVersion must be an exact stable semver version");
		}
		if (
			checkExactKeys(baseline.runtimeDependencies, runtimeDependencyNames, "baseline.runtimeDependencies", failures)
		) {
			for (const dependency of runtimeDependencyNames) {
				const value = baseline.runtimeDependencies[dependency];
				if (
					validateString(value, `baseline.runtimeDependencies.${dependency}`, failures) &&
					!isStableSemver(value)
				) {
					failures.push(`baseline.runtimeDependencies.${dependency} must be an exact stable semver version`);
				}
			}
		}
	}

	if (checkExactKeys(record.budget, budgetKeys, "budget", failures)) {
		for (const key of budgetKeys) {
			if (!Number.isInteger(record.budget[key]) || record.budget[key] < 0) {
				failures.push(`budget.${key} must be a non-negative integer`);
			}
		}
	}

	if (checkExactKeys(record.owned, ownedKeys, "owned", failures)) {
		validatePathArray(record.owned.overlays, "owned.overlays", "owned overlay", true, paths, rules, failures);
		validatePathArray(record.owned.additions, "owned.additions", "owned addition", true, paths, rules, failures);
	}

	if (!Array.isArray(record.deltas)) {
		failures.push("deltas must be an array");
	} else {
		for (const [index, delta] of record.deltas.entries()) {
			const location = `deltas[${index}]`;
			if (!checkExactKeys(delta, deltaKeys, location, failures)) continue;
			if (validateString(delta.id, `${location}.id`, failures)) {
				if (!/^[a-z\d]+(?:-[a-z\d]+)*$/.test(delta.id)) {
					failures.push(`${location}.id must be a lower-kebab stable identifier`);
				}
				trackUnique(delta.id, `${location}.id`, "delta unit ID", unitIds, failures);
			}
			if (validateString(delta.title, `${location}.title`, failures)) {
				trackUnique(delta.title, `${location}.title`, "delta unit title", unitTitles, failures);
			}
			if (
				validateString(delta.disposition, `${location}.disposition`, failures) &&
				!validDispositions.has(delta.disposition)
			) {
				failures.push(`${location}.disposition must be one of ${[...validDispositions].join(", ")}`);
			}
			if (validateString(delta.risk, `${location}.risk`, failures) && !validRisks.has(delta.risk)) {
				failures.push(`${location}.risk must be one of ${[...validRisks].join(", ")}`);
			}
			if (!Array.isArray(delta.privateUpstreamAssumptions)) {
				failures.push(`${location}.privateUpstreamAssumptions must be an array`);
			} else {
				for (const [assumptionIndex, assumption] of delta.privateUpstreamAssumptions.entries()) {
					const assumptionLocation = `${location}.privateUpstreamAssumptions[${assumptionIndex}]`;
					if (validateString(assumption, assumptionLocation, failures)) {
						trackUnique(assumption, assumptionLocation, "private upstream assumption", assumptions, failures);
					}
				}
			}
			validatePathArray(delta.modified, `${location}.modified`, "hybrid", false, paths, rules, failures);
			validatePathArray(delta.dropped, `${location}.dropped`, "dropped", false, paths, rules, failures);
			if (
				Array.isArray(delta.modified) &&
				Array.isArray(delta.dropped) &&
				delta.modified.length + delta.dropped.length === 0
			) {
				failures.push(`${location} must register at least one modified or dropped path`);
			}
		}
	}

	for (let firstIndex = 0; firstIndex < rules.length; firstIndex++) {
		for (let secondIndex = firstIndex + 1; secondIndex < rules.length; secondIndex++) {
			const first = rules[firstIndex];
			const second = rules[secondIndex];
			if (rulesOverlap(first, second)) {
				failures.push(
					`${first.location} (${first.pattern}) overlaps or shadows ${second.location} (${second.pattern}); every path must have exactly one registry rule`,
				);
			}
		}
	}

	return { failures, rules };
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

function readSourcePackage(sourceTree, failures, tryGit) {
	const sourcePackageText = tryGit("show", `${sourceTree}:package.json`);
	if (sourcePackageText === undefined) {
		failures.push(`baseline.sourceTree ${sourceTree} does not contain package.json`);
		return undefined;
	}
	return parseJson(sourcePackageText, `${sourceTree}:package.json`, failures);
}

function verifyBaseline(record, failures, warnings, tryGit) {
	const { baseline } = record;
	const sourceTreeType = tryGit("cat-file", "-t", baseline.sourceTree);
	let sourcePackage;
	if (sourceTreeType !== "tree") {
		failures.push(
			`baseline.sourceTree ${baseline.sourceTree} is not available as a tree object; fetch upstream tags or correct maintainers/upstream.json`,
		);
	} else {
		sourcePackage = readSourcePackage(baseline.sourceTree, failures, tryGit);
		if (!isPlainObject(sourcePackage)) {
			if (sourcePackage !== undefined) failures.push(`${baseline.sourceTree}:package.json must be an object`);
		} else {
			if (sourcePackage.version !== baseline.codingAgentVersion) {
				failures.push(
					`baseline.codingAgentVersion ${baseline.codingAgentVersion} does not match ${baseline.sourceTree}:package.json (${String(sourcePackage.version)})`,
				);
			}
		}
	}

	const tagObject = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${baseline.tag}`);
	if (tagObject !== undefined) {
		const tagCommit = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${baseline.tag}^{commit}`);
		if (!tagCommit) {
			failures.push(`tag ${baseline.tag} does not resolve to a commit`);
		} else {
			if (tagCommit !== baseline.commit) {
				failures.push(`baseline.commit ${baseline.commit} does not match tag ${baseline.tag} (${tagCommit})`);
			}
			const tagTree = tryGit("rev-parse", "--verify", "--quiet", `${tagCommit}:${baseline.sourceSubtree}`);
			if (!tagTree) {
				failures.push(`tag ${baseline.tag} does not contain the recorded source subtree ${baseline.sourceSubtree}`);
			} else {
				const tagTreeType = tryGit("cat-file", "-t", tagTree);
				if (tagTreeType !== "tree") {
					failures.push(`tag ${baseline.tag}:${baseline.sourceSubtree} is not a tree`);
				} else if (tagTree !== baseline.sourceTree) {
					failures.push(
						`baseline.sourceTree ${baseline.sourceTree} does not match ${baseline.tag}:${baseline.sourceSubtree} (${tagTree})`,
					);
				}
			}
		}
	} else if (sourceTreeType === "tree") {
		warnings.push(
			`tag ${baseline.tag} is unavailable locally; using recorded canonical source tree ${baseline.sourceTree.slice(0, 12)}`,
		);
	}

	const remotes = parseRemoteNames(tryGit("remote"));
	if (remotes.includes("upstream")) {
		const upstreamUrl = tryGit("remote", "get-url", "upstream");
		const upstreamRepository = normalizeGithubRepository(upstreamUrl);
		const baselineRepository = normalizeRepository(baseline.repository);
		if (!upstreamRepository) {
			failures.push(`upstream remote URL ${JSON.stringify(upstreamUrl ?? "")} is not a GitHub owner/repository URL`);
		} else if (upstreamRepository !== baselineRepository) {
			failures.push(
				`upstream remote ${upstreamRepository} does not match baseline.repository ${baseline.repository}`,
			);
		}
	}

	return sourcePackage;
}

function verifyDependencyValue(value, expected, location, failures) {
	if (value !== expected) {
		failures.push(`${location} must equal baseline.runtimeDependencies (${expected}); found ${String(value)}`);
	}
}

function verifyRuntimeDependencies(record, sourcePackage, failures, root) {
	const packageJson = readJsonFile(join(root, "package.json"), "package.json", failures);
	const shrinkwrap = readJsonFile(join(root, "npm-shrinkwrap.json"), "npm-shrinkwrap.json", failures);
	const expectedDependencies = record.baseline.runtimeDependencies;

	if (!isPlainObject(packageJson)) {
		if (packageJson !== undefined) failures.push("package.json must be an object");
	} else if (!isPlainObject(packageJson.dependencies)) {
		failures.push("package.json.dependencies must be an object");
	} else {
		for (const dependency of runtimeDependencyNames) {
			verifyDependencyValue(
				packageJson.dependencies[dependency],
				expectedDependencies[dependency],
				`package.json.dependencies.${dependency}`,
				failures,
			);
		}
	}

	let shrinkwrapPackages;
	let shrinkwrapRoot;
	if (!isPlainObject(shrinkwrap)) {
		if (shrinkwrap !== undefined) failures.push("npm-shrinkwrap.json must be an object");
	} else if (!isPlainObject(shrinkwrap.packages)) {
		failures.push("npm-shrinkwrap.json.packages must be an object");
	} else {
		shrinkwrapPackages = shrinkwrap.packages;
		shrinkwrapRoot = shrinkwrapPackages[""];
		if (!isPlainObject(shrinkwrapRoot)) {
			failures.push('npm-shrinkwrap.json.packages[""] must be an object');
		} else if (!isPlainObject(shrinkwrapRoot.dependencies)) {
			failures.push('npm-shrinkwrap.json.packages[""].dependencies must be an object');
		}
	}

	for (const dependency of runtimeDependencyNames) {
		const expected = expectedDependencies[dependency];
		if (isPlainObject(shrinkwrapRoot) && isPlainObject(shrinkwrapRoot.dependencies)) {
			verifyDependencyValue(
				shrinkwrapRoot.dependencies[dependency],
				expected,
				`npm-shrinkwrap.json.packages[""].dependencies.${dependency}`,
				failures,
			);
		}
		const installed = shrinkwrapPackages?.[`node_modules/${dependency}`];
		if (!isPlainObject(installed)) {
			failures.push(`npm-shrinkwrap.json is missing installed package entry node_modules/${dependency}`);
		} else {
			verifyDependencyValue(
				installed.version,
				expected,
				`npm-shrinkwrap.json.packages.node_modules/${dependency}.version`,
				failures,
			);
		}
	}

	if (!isPlainObject(sourcePackage)) return;
	if (!isPlainObject(sourcePackage.dependencies)) {
		failures.push("canonical upstream package.json.dependencies must be an object");
		return;
	}
	for (const dependency of runtimeDependencyNames) {
		const range = sourcePackage.dependencies[dependency];
		if (!isNonEmptyString(range)) {
			failures.push(`canonical upstream package.json.dependencies.${dependency} must be a dependency range`);
			continue;
		}
		try {
			if (!satisfies(expectedDependencies[dependency], range)) {
				failures.push(
					`baseline.runtimeDependencies.${dependency} ${expectedDependencies[dependency]} does not satisfy upstream coding-agent range ${range}`,
				);
			}
		} catch {
			failures.push(
				`canonical upstream package.json.dependencies.${dependency} has invalid range ${JSON.stringify(range)}`,
			);
		}
	}
}

export function parseNameStatus(output) {
	if (!output) return [];
	const fields = output.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const entries = [];
	for (let index = 0; index < fields.length; index += 2) {
		if (fields[index + 1] === undefined)
			throw new Error("git diff --name-status returned an incomplete NUL-delimited entry");
		entries.push({ path: fields[index + 1], status: fields[index] });
	}
	return entries;
}

export function collectWorktreeEntries(baselineTree, failures, git) {
	const entries = new Map();
	for (const entry of parseNameStatus(git("diff", "--name-status", "-z", "--no-renames", baselineTree, "--"))) {
		entries.set(entry.path, entry);
	}
	const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
	for (const path of untracked.split("\0")) {
		if (!path) continue;
		if (entries.has(path)) {
			failures.push(
				`path appears in both the baseline-worktree diff and git ls-files --others: ${path}; reconcile the tracked and untracked versions before rerunning`,
			);
			continue;
		}
		entries.set(path, { path, status: "A" });
	}
	return [...entries.values()].sort((first, second) => {
		if (first.path < second.path) return -1;
		if (first.path > second.path) return 1;
		return 0;
	});
}

function describeStatus(status) {
	if (status === "A") return "local addition";
	if (status === "D") return "local deletion";
	if (status === "M") return "local modification";
	return `local ${status || "unknown"} change`;
}

function expectedStatuses(rule) {
	if (rule.ruleKind === "owned overlay") return supportedStatuses;
	if (rule.ruleKind === "owned addition") return new Set(["A"]);
	if (rule.ruleKind === "hybrid") return new Set(["M"]);
	return new Set(["D"]);
}

export function classifyEntries(entries, rules, failures) {
	const hybridChanges = [];
	const ownedChanges = [];
	const droppedChanges = [];
	const unregisteredChanges = [];
	const usedRules = new Set();

	for (const entry of entries) {
		const matches = rules.filter((rule) => ruleMatches(rule, entry.path));
		if (matches.length === 0) {
			unregisteredChanges.push(entry);
			failures.push(
				`unregistered ${describeStatus(entry.status)}: ${entry.path} (register it in maintainers/upstream.json or align with upstream)`,
			);
			if (!supportedStatuses.has(entry.status))
				failures.push(`unexpected diff status ${entry.status}: ${entry.path}`);
			continue;
		}
		if (matches.length !== 1) {
			failures.push(
				`ambiguous registry match for ${entry.path}: ${matches.map((rule) => `${rule.location} (${rule.pattern})`).join(", ")}`,
			);
			continue;
		}

		const rule = matches[0];
		usedRules.add(rule);
		if (rule.ruleKind.startsWith("owned")) ownedChanges.push(entry);
		else if (rule.ruleKind === "hybrid") hybridChanges.push(entry);
		else droppedChanges.push(entry);

		if (!expectedStatuses(rule).has(entry.status)) {
			failures.push(
				`${rule.ruleKind} rule ${rule.location} (${rule.pattern}) requires ${[...expectedStatuses(rule)].join("/")} status, found ${entry.status}: ${entry.path}`,
			);
		}
		if (!supportedStatuses.has(entry.status)) failures.push(`unexpected diff status ${entry.status}: ${entry.path}`);
	}

	for (const rule of rules) {
		if (!usedRules.has(rule)) {
			failures.push(
				`maintainers/upstream.json: ${rule.location} (${rule.pattern}) matches no difference against the baseline`,
			);
		}
	}

	return { droppedChanges, hybridChanges, ownedChanges, unregisteredChanges };
}

export function buildBudgetMetrics(record, rules, changes) {
	const hybridRules = rules.filter((rule) => rule.ruleKind === "hybrid");
	const droppedRules = rules.filter((rule) => rule.ruleKind === "dropped");
	const sourceHybridRules = hybridRules.filter((rule) => rule.base.startsWith("src/"));
	const sourceHybridChanges = changes.hybridChanges.filter((entry) => entry.path.startsWith("src/"));
	const highRiskUnits = record.deltas.filter((delta) => delta.risk === "high").length;
	const privateAssumptions = record.deltas.reduce(
		(count, delta) => count + delta.privateUpstreamAssumptions.length,
		0,
	);
	return [
		{
			actual: changes.hybridChanges.length,
			budgetKey: "hybridPathCeiling",
			label: "hybrid paths",
			registered: hybridRules.length,
		},
		{
			actual: sourceHybridChanges.length,
			budgetKey: "hybridSourcePathCeiling",
			label: "hybrid source paths",
			registered: sourceHybridRules.length,
		},
		{
			actual: changes.droppedChanges.length,
			budgetKey: "droppedPathCeiling",
			label: "dropped paths",
			registered: droppedRules.length,
		},
		{
			actual: record.deltas.length,
			budgetKey: "deltaUnitCeiling",
			label: "delta units",
			registered: record.deltas.length,
		},
		{
			actual: highRiskUnits,
			budgetKey: "highRiskUnitCeiling",
			label: "high-risk delta units",
			registered: highRiskUnits,
		},
		{
			actual: privateAssumptions,
			budgetKey: "privateUpstreamAssumptionCeiling",
			label: "private upstream assumptions",
			registered: privateAssumptions,
		},
	];
}

export function enforceBudget(metrics, budget, failures) {
	for (const metric of metrics) {
		const ceiling = budget[metric.budgetKey];
		if (metric.actual === ceiling && metric.registered === ceiling) continue;
		if (metric.actual !== metric.registered) {
			const directions = [
				["actual", metric.actual],
				["registered", metric.registered],
			]
				.map(([kind, count]) => {
					if (count > ceiling) return `${kind} total ${count} grows the delta`;
					if (count < ceiling) return `${kind} total ${count} requires the ceiling to ratchet down`;
					return `${kind} total matches the ceiling`;
				})
				.join("; ");
			failures.push(
				`budget.${metric.budgetKey} must equal ${metric.label}: actual ${metric.actual}, registered ${metric.registered}, ceiling ${ceiling}. ${directions}. Resolve the registry/classification mismatch before setting the ceiling to the shared count.`,
			);
			continue;
		}
		if (metric.actual > ceiling) {
			failures.push(
				`budget.${metric.budgetKey} is ${ceiling}, but ${metric.label} total ${metric.actual} grows the delta. Remove or reduce the delta, or record the required owner-approved exception before increasing the ceiling.`,
			);
		} else {
			failures.push(
				`budget.${metric.budgetKey} is ${ceiling}, but ${metric.label} total is ${metric.actual}. Ratchet the ceiling down to ${metric.actual}.`,
			);
		}
	}
}

function printReport(record, baselineTree, baselineFileCount, entries, changes, metrics, stdout) {
	const log = (value = "") => writeLine(stdout, value);
	const { baseline } = record;
	const modifiedOrDeleted = entries.filter((entry) => entry.status !== "A").length;
	const unchangedCount = baselineFileCount - modifiedOrDeleted;
	log(`Upstream baseline: ${baseline.tag} ${baseline.sourceSubtree} (tree ${baselineTree.slice(0, 12)})`);
	log("Compared against: current worktree (tracked staged/unstaged changes and nonignored untracked files)");
	log("");
	log(`  ${String(unchangedCount).padStart(4)} files unchanged from upstream`);
	log(
		`  ${String(changes.hybridChanges.length).padStart(4)} hybrid files (registered upstream files with local modifications)`,
	);
	log(`  ${String(changes.ownedChanges.length).padStart(4)} distribution-owned files (registered local paths)`);
	log(
		`  ${String(changes.droppedChanges.length).padStart(4)} dropped upstream files (registered intentional deletions)`,
	);
	log(`  ${String(changes.unregisteredChanges.length).padStart(4)} unregistered differences`);
	log("");
	log("Delta budget (actual / registered / ceiling):");
	for (const metric of metrics) {
		log(
			`  ${metric.label}: ${metric.actual} / ${metric.registered} / ${record.budget[metric.budgetKey]} (${metric.budgetKey})`,
		);
	}
	log("");
	log(
		`Delta units: ${record.deltas.length} total; ${metrics.find((metric) => metric.budgetKey === "highRiskUnitCeiling").actual} high-risk; ${metrics.find((metric) => metric.budgetKey === "privateUpstreamAssumptionCeiling").actual} private upstream assumptions.`,
	);
	for (const [title, entriesForTitle] of [
		["Hybrid", changes.hybridChanges],
		["Distribution-owned", changes.ownedChanges],
		["Dropped", changes.droppedChanges],
		["Unregistered", changes.unregisteredChanges],
	]) {
		if (entriesForTitle.length === 0) continue;
		log("");
		log(`${title}:`);
		for (const entry of entriesForTitle) log(`  ${entry.status} ${entry.path}`);
	}
}

function writeLine(stream, value) {
	stream.write(`${value}\n`);
}

function printFailures(failures, stderr) {
	if (failures.length === 0) return;
	writeLine(stderr, "Upstream baseline checks failed:");
	for (const failure of failures) writeLine(stderr, `  - ${failure}`);
}

export function runDiffUpstream({ root, args = [], stdout = process.stdout, stderr = process.stderr }) {
	const knownFlags = new Set(["--check", "--update-baseline"]);
	if (args.some((flag) => !knownFlags.has(flag)) || args.length > 1) {
		writeLine(stderr, usage);
		return 2;
	}
	const mode = args[0] === "--check" ? "check" : args[0] === "--update-baseline" ? "update" : "report";
	const { git, tryGit } = createGit(root);
	const schemaFailures = [];
	const record = readJsonFile(join(root, "maintainers", "upstream.json"), "maintainers/upstream.json", schemaFailures);
	let rules = [];
	if (record !== undefined) {
		const validation = validateManifest(record);
		schemaFailures.push(...validation.failures);
		rules = validation.rules;
	}
	if (schemaFailures.length > 0) {
		printFailures(schemaFailures, stderr);
		return 1;
	}

	const failures = [];
	const warnings = [];
	const sourcePackage = verifyBaseline(record, failures, warnings, tryGit);
	verifyRuntimeDependencies(record, sourcePackage, failures, root);
	if (failures.length > 0) {
		for (const warning of warnings) writeLine(stderr, `warning: ${warning}`);
		printFailures(failures, stderr);
		return 1;
	}

	const { baseline } = record;
	const baselineTree = baseline.sourceTree;
	const branchCommit = tryGit("rev-parse", "--verify", "--quiet", `refs/heads/${baselineBranch}`);
	const branchTree = branchCommit ? tryGit("rev-parse", "--verify", "--quiet", `${baselineBranch}^{tree}`) : undefined;
	if (mode === "update") {
		if (branchTree === baselineTree) {
			writeLine(
				stdout,
				`${baselineBranch} already matches canonical ${baseline.tag} tree ${baselineTree.slice(0, 12)}.`,
			);
		} else {
			const message = `${baselineBranch}: ${baseline.tag} ${baseline.sourceSubtree}\n\nRoot-mapped extraction of the canonical ${baseline.sourceSubtree} tree recorded for\nupstream tag ${baseline.tag} (commit ${baseline.commit}). Serves as the diff base for the\nstandalone distribution; never merged into main.`;
			const baselineCommit = git("commit-tree", baselineTree, "-m", message);
			git("branch", "-f", baselineBranch, baselineCommit);
			writeLine(stdout, `${baselineBranch} now points at ${baselineCommit.slice(0, 12)} (${baseline.tag}).`);
		}
		for (const warning of warnings) writeLine(stderr, `warning: ${warning}`);
		return 0;
	}

	if (branchCommit && branchTree !== baselineTree) {
		failures.push(
			`baseline cache ${baselineBranch} does not match canonical ${baseline.tag}; run: node scripts/diff-upstream.mjs --update-baseline`,
		);
	}
	const baselineFileCount = git("ls-tree", "-r", "--name-only", baselineTree).split("\n").filter(Boolean).length;
	const entries = collectWorktreeEntries(baselineTree, failures, git);
	const changes = classifyEntries(entries, rules, failures);
	const metrics = buildBudgetMetrics(record, rules, changes);
	enforceBudget(metrics, record.budget, failures);
	if (mode === "report") printReport(record, baselineTree, baselineFileCount, entries, changes, metrics, stdout);
	for (const warning of warnings) writeLine(stderr, `warning: ${warning}`);
	if (failures.length > 0) {
		printFailures(failures, stderr);
		return 1;
	}
	if (mode === "check") {
		writeLine(
			stdout,
			`Verified ${entries.length} worktree differences against ${baseline.tag}: ${changes.hybridChanges.length} hybrid, ${changes.ownedChanges.length} distribution-owned, ${changes.droppedChanges.length} dropped, 0 unregistered.`,
		);
	}
	return 0;
}
