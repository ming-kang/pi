#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baselineBranch = "upstream-extract";

const usage = `Usage: node scripts/diff-upstream.mjs [--check | --update-baseline]

Compares the repository against the reviewed upstream coding-agent baseline
recorded in maintainers/upstream.json and classifies every difference as
hybrid (registered upstream file with local modifications), distribution-owned
(registered local path), or unregistered drift.

  (no flag)          print the full classification report
  --check            print only problems; exit 1 on unregistered drift,
                     stale registrations, or a stale baseline branch
  --update-baseline  create or move the ${baselineBranch} branch to the
                     root-mapped extraction of the reviewed upstream tag`;

const knownFlags = new Set(["--check", "--update-baseline"]);
const flags = process.argv.slice(2);
if (flags.some((flag) => !knownFlags.has(flag)) || flags.length > 1) {
	console.error(usage);
	process.exit(2);
}
const mode = flags[0] === "--check" ? "check" : flags[0] === "--update-baseline" ? "update" : "report";

function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

function tryGit(...args) {
	try {
		return git(...args);
	} catch {
		return undefined;
	}
}

function globToRegExp(pattern) {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index++;
				if (pattern[index + 1] === "/") index++;
			} else {
				source += "[^/]*";
			}
		} else if ("\\^$.|?+()[]{}".includes(character)) {
			source += `\\${character}`;
		} else {
			source += character;
		}
	}
	return new RegExp(`^${source}$`);
}

const record = JSON.parse(readFileSync(join(root, "maintainers", "upstream.json"), "utf8"));
const { reviewedTag, reviewedCommit, sourceSubtree } = record;
const localOnlyPatterns = (record.localOnly ?? []).map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
const hybridPatterns = (record.hybrid ?? []).map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
const droppedPatterns = (record.dropped ?? []).map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));

const failures = [];
const warnings = [];

const tagCommit = tryGit("rev-parse", "--verify", "--quiet", `${reviewedTag}^{commit}`);
const tagTree = tagCommit && tryGit("rev-parse", "--verify", "--quiet", `${reviewedTag}^{tree}:${sourceSubtree}`);
const branchCommit = tryGit("rev-parse", "--verify", "--quiet", `refs/heads/${baselineBranch}`);
const branchTree = branchCommit && git("rev-parse", `${baselineBranch}^{tree}`);

if (tagCommit && reviewedCommit && tagCommit !== reviewedCommit) {
	failures.push(
		`maintainers/upstream.json: reviewedCommit ${reviewedCommit} does not match tag ${reviewedTag} (${tagCommit})`,
	);
}
if (tagCommit && !tagTree) {
	failures.push(`tag ${reviewedTag} does not contain the recorded source subtree ${sourceSubtree}`);
}

if (mode === "update") {
	if (!tagTree) {
		console.error(`Cannot resolve ${reviewedTag}:${sourceSubtree}; run: git fetch upstream --tags`);
		process.exit(1);
	}
	if (branchTree === tagTree) {
		console.log(`${baselineBranch} already matches ${reviewedTag} (tree ${tagTree.slice(0, 12)}).`);
	} else {
		const message = `${baselineBranch}: ${reviewedTag} ${sourceSubtree}\n\nRoot-mapped extraction of ${sourceSubtree} from upstream tag ${reviewedTag}\n(commit ${tagCommit}). Serves as the diff base for the standalone\ndistribution; never merged into main.`;
		const commit = git("commit-tree", tagTree, "-m", message);
		git("branch", "-f", baselineBranch, commit);
		console.log(`${baselineBranch} now points at ${commit.slice(0, 12)} (${reviewedTag}).`);
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

const baselineTree = tagTree ?? branchTree;
if (!baselineTree) {
	console.error(
		`Cannot resolve an upstream baseline: tag ${reviewedTag} is unavailable and the ${baselineBranch} branch does not exist.\nRun: git fetch upstream --tags && node scripts/diff-upstream.mjs --update-baseline`,
	);
	process.exit(1);
}
if (!tagTree) {
	warnings.push(`tag ${reviewedTag} is unavailable locally; using the ${baselineBranch} branch as the baseline`);
} else if (!branchCommit) {
	failures.push(
		`baseline branch ${baselineBranch} does not exist; run: node scripts/diff-upstream.mjs --update-baseline`,
	);
} else if (branchTree !== tagTree) {
	failures.push(
		`baseline branch ${baselineBranch} does not match ${reviewedTag}; run: node scripts/diff-upstream.mjs --update-baseline`,
	);
}

const baselineFileCount = git("ls-tree", "-r", "--name-only", baselineTree).split("\n").filter(Boolean).length;
const diffOutput = git("diff", "--name-status", "--no-renames", baselineTree, "HEAD");
const entries = diffOutput
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		const [status, path] = line.split("\t");
		return { status, path };
	});

const hybridChanges = [];
const ownedChanges = [];
const droppedChanges = [];
const unregisteredChanges = [];
const usedLocalOnlyPatterns = new Set();
const usedHybridPatterns = new Set();
const usedDroppedPatterns = new Set();

for (const entry of entries) {
	const localOnlyMatch = localOnlyPatterns.find(({ regexp }) => regexp.test(entry.path));
	if (localOnlyMatch) {
		usedLocalOnlyPatterns.add(localOnlyMatch.pattern);
		ownedChanges.push(entry);
		continue;
	}
	const hybridMatch = hybridPatterns.find(({ regexp }) => regexp.test(entry.path));
	if (hybridMatch) {
		usedHybridPatterns.add(hybridMatch.pattern);
		hybridChanges.push(entry);
		if (entry.status !== "M") {
			failures.push(`registered hybrid path is not a modification (${entry.status}): ${entry.path}`);
		}
		continue;
	}
	const droppedMatch = droppedPatterns.find(({ regexp }) => regexp.test(entry.path));
	if (droppedMatch) {
		usedDroppedPatterns.add(droppedMatch.pattern);
		droppedChanges.push(entry);
		if (entry.status !== "D") {
			failures.push(`registered dropped path is not a deletion (${entry.status}): ${entry.path}`);
		}
		continue;
	}
	unregisteredChanges.push(entry);
	const kind =
		entry.status === "A" ? "local addition" : entry.status === "D" ? "local deletion" : "local modification";
	failures.push(
		`unregistered ${kind}: ${entry.path} (register it in maintainers/upstream.json or align with upstream)`,
	);
}

for (const { pattern } of localOnlyPatterns) {
	if (!usedLocalOnlyPatterns.has(pattern)) {
		failures.push(
			`maintainers/upstream.json: localOnly pattern matches no difference against the baseline: ${pattern}`,
		);
	}
}
for (const { pattern } of hybridPatterns) {
	if (!usedHybridPatterns.has(pattern)) {
		failures.push(`maintainers/upstream.json: hybrid pattern matches no difference against the baseline: ${pattern}`);
	}
}
for (const { pattern } of droppedPatterns) {
	if (!usedDroppedPatterns.has(pattern)) {
		failures.push(
			`maintainers/upstream.json: dropped pattern matches no difference against the baseline: ${pattern}`,
		);
	}
}

const modifiedOrDeleted = entries.filter((entry) => entry.status !== "A").length;
const unchangedCount = baselineFileCount - modifiedOrDeleted;

if (mode === "report") {
	console.log(`Upstream baseline: ${reviewedTag} ${sourceSubtree} (tree ${baselineTree.slice(0, 12)})`);
	console.log(`Compared against: HEAD (uncommitted changes are not included)`);
	console.log("");
	console.log(`  ${String(unchangedCount).padStart(4)} files unchanged from upstream`);
	console.log(
		`  ${String(hybridChanges.length).padStart(4)} hybrid files (registered upstream files with local modifications)`,
	);
	console.log(`  ${String(ownedChanges.length).padStart(4)} distribution-owned files (registered local paths)`);
	console.log(
		`  ${String(droppedChanges.length).padStart(4)} dropped upstream files (registered intentional deletions)`,
	);
	console.log(`  ${String(unregisteredChanges.length).padStart(4)} unregistered differences`);
	for (const [title, changes] of [
		["Hybrid", hybridChanges],
		["Distribution-owned", ownedChanges],
		["Dropped", droppedChanges],
		["Unregistered", unregisteredChanges],
	]) {
		if (changes.length === 0) continue;
		console.log("");
		console.log(`${title}:`);
		for (const entry of changes) console.log(`  ${entry.status} ${entry.path}`);
	}
	if (warnings.length > 0 || failures.length > 0) console.log("");
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (failures.length > 0) {
	console.error("Upstream baseline checks failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
if (mode === "check") {
	console.log(
		`Verified ${entries.length} differences against ${reviewedTag}: ${hybridChanges.length} hybrid, ${ownedChanges.length} distribution-owned, ${droppedChanges.length} dropped, 0 unregistered.`,
	);
}
