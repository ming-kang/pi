#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	applyUpstreamRelease,
	concernsTouching,
	createGit,
	isReviewPath,
	isStableReleaseTag,
	parseNameStatus,
	registerUpstreamAdoptions,
} from "./diff-upstream.mjs";

const usage = `Usage: npm run sync -- <v<version> | --verify>

  v<version>  start a synchronization: branch sync/upstream-v<version> from main,
              merge the upstream release, and move the @earendil-works pins to it
  --verify    register hand-ported upstream files, then run format, checks, the
              upstream ledger check, and the tests of every concern upstream touched`;

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "maintainers", "upstream.json");
const { git, tryGit } = createGit(root);

function fail(message) {
	console.error(message);
	process.exit(1);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// Run npm through the same CLI that started this script, so Windows needs no shell.
function npm(...args) {
	const npmCli = process.env.npm_execpath;
	if (!npmCli) fail("Run this script through `npm run sync`.");
	return spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit" }).status === 0;
}

function changedPaths(fromTree, toTree) {
	return parseNameStatus(git("diff", "--name-status", "-z", "--no-renames", fromTree, toTree)).map(
		(entry) => entry.path,
	);
}

/**
 * Concerns with a path that upstream changed and that the committed
 * distribution deviates on. A directory claim also covers files identical to
 * upstream, whose changes merge cleanly and need no re-review.
 */
function touchedConcerns(fromTree, toTree) {
	const ledger = readJson(join(root, "maintainers", "concerns.json"));
	const deviating = new Set(changedPaths(fromTree, "HEAD"));
	return concernsTouching(
		ledger,
		changedPaths(fromTree, toTree).filter((path) => deviating.has(path)),
	);
}

function start(tag) {
	const version = tag.slice(1);
	const branch = `sync/upstream-${tag}`;
	if (git("branch", "--show-current") !== "main") fail("Start a synchronization from main.");
	if (git("status", "--porcelain", "--untracked-files=no")) {
		fail("The worktree has uncommitted tracked changes; commit or set them aside first.");
	}

	const baseline = readJson(manifestPath);
	// Fetch the release and the recorded baseline by URL, so no remote setup is needed.
	const refspecs = [baseline.tag, tag].map((name) => `+refs/tags/${name}:refs/tags/${name}`);
	execFileSync("git", ["fetch", "--no-tags", `https://github.com/${baseline.repository}.git`, ...refspecs], {
		cwd: root,
		stdio: "inherit",
	});
	git("switch", "-c", branch);

	const applied = applyUpstreamRelease({ root, tag, stdout: process.stdout, stderr: process.stderr });
	if (applied.results === undefined) {
		git("switch", "main");
		git("branch", "-D", branch);
		process.exit(1);
	}

	// Upstream publishes every @earendil-works package at the release version.
	const packagePath = join(root, "package.json");
	const pkg = readJson(packagePath);
	for (const group of [pkg.dependencies, pkg.devDependencies]) {
		for (const name of Object.keys(group ?? {})) {
			if (name.startsWith("@earendil-works/")) group[name] = version;
		}
	}
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, "\t")}\n`);
	console.log(`\nMoving @earendil-works pins to ${version} (release-age exception for the selected release)...`);
	const installed = npm("install", "--ignore-scripts", "--min-release-age=0");

	const touched = touchedConcerns(applied.from.sourceTree, applied.to.sourceTree);
	if (touched.length > 0) {
		console.log("\nConcerns whose paths upstream changed (re-review each):");
		for (const { concern, paths } of touched) {
			const shown = paths.filter((path) => !isReviewPath(path));
			console.log(`  ${concern.id}${shown.length > 0 ? `: ${shown.join(", ")}` : ""}`);
		}
	}
	console.log(`\nRelease notes: https://github.com/${baseline.repository}/releases/tag/${tag}`);
	console.log(`
Next, on ${branch}:
  1. Resolve conflicts; port review paths, adding new docs pages to docs/docs.json.
  2. Add user-visible changes to CHANGELOG.md under [Unreleased]; update maintainers/concerns.json.
  3. npm run sync -- --verify, then commit "feat: sync upstream ${tag}" with the
     adoption decisions and conflict resolutions in the body.`);
	if (!installed) fail("\nnpm install failed; fix it and rerun npm install --ignore-scripts --min-release-age=0.");
	if (applied.code !== 0) process.exit(applied.code);
}

function verify() {
	const committedText = tryGit("show", "HEAD:maintainers/upstream.json");
	const from = committedText === undefined ? undefined : JSON.parse(committedText);
	const to = readJson(manifestPath);
	if (from === undefined || from.sourceTree === to.sourceTree) {
		fail("No synchronization in progress: maintainers/upstream.json matches HEAD.");
	}

	const registered = registerUpstreamAdoptions(to, git);
	for (const path of registered) console.log(`registered ${path}`);

	const steps = [
		["format", () => npm("run", "format")],
		["check", () => npm("run", "check")],
		["upstream ledger", () => npm("run", "diff:upstream", "--", "--check")],
	];
	const tests = [
		...new Set(touchedConcerns(from.sourceTree, to.sourceTree).flatMap(({ concern }) => concern.tests ?? [])),
	].sort();
	if (tests.length > 0)
		steps.push([`${tests.length} concern tests`, () => npm("run", "test:isolated", "--", ...tests)]);
	for (const [name, run] of steps) {
		console.log(`\n== ${name}`);
		if (!run()) fail(`\n${name} failed.`);
	}

	console.log(`
Verified ${from.tag} -> ${to.tag}. Stage the synchronization's paths, review the staged diff, and commit:
  git commit -m "feat: sync upstream ${to.tag}" -m "<adoption decisions and conflict resolutions>"
Then land it and release:
  git switch main && git merge --ff-only sync/upstream-${to.tag} && git branch -d sync/upstream-${to.tag}
  npm run release`);
}

const [argument, ...rest] = process.argv.slice(2);
if (rest.length > 0 || argument === undefined) {
	fail(usage);
} else if (argument === "--verify") {
	verify();
} else if (isStableReleaseTag(argument)) {
	start(argument);
} else {
	fail(usage);
}
