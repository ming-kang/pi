#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const usage = `Usage: npm run release -- [<version>] [--dry-run] [--yes]

  (default)  check that main is pushed and its CI passed, stamp CHANGELOG [Unreleased], bump the
             version, commit, and push main; CI publishes that release commit once it passes.
             A version whose release never reached npm is released again instead of bumped.
  <version>  release this version instead of the next one in upstream's major.minor line
  --dry-run  print the version and changelog section without asking or changing anything
  --yes      commit and push the release without asking`;

const PACKAGE_NAME = "@astralyn/pi";
const UNRELEASED = "## [Unreleased]";

function parseVersion(version) {
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? "");
	if (!match) throw new Error(`Expected a stable major.minor.patch version, got ${JSON.stringify(version)}.`);
	return match.slice(1).map(Number);
}

/**
 * The next release follows upstream's major.minor line and owns the patch:
 * a newer upstream line starts at patch 0, otherwise the patch increments.
 */
export function nextVersion(current, upstreamTag) {
	const [major, minor, patch] = parseVersion(current);
	const [upstreamMajor, upstreamMinor] = parseVersion(upstreamTag);
	if (upstreamMajor > major || (upstreamMajor === major && upstreamMinor > minor)) {
		return `${upstreamMajor}.${upstreamMinor}.0`;
	}
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Move the root version in the lockfile. `npm version` only rewrites
 * package.json, and the lockfile checks require all three copies to match.
 */
export function stampLockfile(text, version) {
	const lock = JSON.parse(text);
	lock.version = version;
	if (lock.packages?.[""]) lock.packages[""].version = version;
	return `${JSON.stringify(lock, null, "\t")}\n`;
}

/** Move the [Unreleased] entries under a new release heading, leaving [Unreleased] empty. */
export function stampChangelog(text, version, date) {
	const lines = text.split("\n");
	const start = lines.indexOf(UNRELEASED);
	if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading.`);
	if (lines.some((line) => line.startsWith(`## [${version}]`))) {
		throw new Error(`CHANGELOG.md already has a heading for ${version}.`);
	}
	let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	if (end === -1) end = lines.length;
	const body = lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
	if (!body) throw new Error("CHANGELOG.md [Unreleased] is empty; there is nothing to release.");
	const rest = lines.slice(end).join("\n");
	return [...lines.slice(0, start), UNRELEASED, "", `## [${version}] - ${date}`, "", body, "", rest].join("\n");
}

/** A release body as its leading text and `### ` groups, in order, each trimmed. */
function changelogGroups(lines) {
	const groups = [{ heading: "", lines: [] }];
	for (const line of lines) {
		if (line.startsWith("### ")) groups.push({ heading: line, lines: [] });
		else groups.at(-1).lines.push(line);
	}
	return groups.map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }));
}

/**
 * Fold the [Unreleased] entries into the newest release's own groups and date it again, for a
 * release whose CI failed before it reached npm. The version keeps one section listing
 * everything it finally ships.
 */
export function restampChangelog(text, version, date) {
	const lines = text.split("\n");
	const start = lines.indexOf(UNRELEASED);
	if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading.`);
	const sectionEnd = (from) => {
		const end = lines.findIndex((line, index) => index > from && line.startsWith("## "));
		return end === -1 ? lines.length : end;
	};
	const heading = sectionEnd(start);
	if (!lines[heading]?.startsWith(`## [${version}] - `)) {
		throw new Error(`CHANGELOG.md's newest release is not ${version}, so there is nothing to release again.`);
	}
	const end = sectionEnd(heading);
	const groups = changelogGroups(lines.slice(heading + 1, end));
	for (const entry of changelogGroups(lines.slice(start + 1, heading))) {
		if (!entry.body) continue;
		const group = groups.find((candidate) => candidate.heading === entry.heading);
		if (group) group.body = group.body ? `${group.body}\n${entry.body}` : entry.body;
		else groups.push(entry);
	}
	const body = groups
		.filter((group) => group.body)
		.map((group) => (group.heading ? `${group.heading}\n\n${group.body}` : group.body))
		.join("\n\n");
	const rest = lines.slice(end).join("\n");
	return [...lines.slice(0, start), UNRELEASED, "", `## [${version}] - ${date}`, "", body, "", rest].join("\n");
}

const root = resolve(import.meta.dirname, "..");

function run(command, args, { capture = false, allowFailure = false } = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0 && !allowFailure) {
		throw new Error(`${command} ${args.join(" ")} failed${capture ? `:\n${result.stderr}` : "."}`);
	}
	return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" };
}

const git = (...args) => run("git", args, { capture: true }).stdout;

// Run npm through the same CLI that started this script, so Windows needs no shell.
function npm(args, options) {
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Run this script through `npm run release`.");
	return run(process.execPath, [npmCli, ...args], options);
}

// The GitHub CLI; tests point PI_RELEASE_GH at a Node script standing in for it.
function gh(args) {
	const standIn = process.env.PI_RELEASE_GH;
	return standIn ? run(process.execPath, [standIn, ...args], { capture: true }) : run("gh", args, { capture: true });
}

function githubRepository() {
	const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	return new URL(repository.url).pathname.replace(/^\//, "").replace(/\.git$/, "");
}

function isPublished(version) {
	const result = npm(["view", `${PACKAGE_NAME}@${version}`, "version", "--registry=https://registry.npmjs.org"], {
		capture: true,
		allowFailure: true,
	});
	if (result.ok) return result.stdout !== "";
	if (result.stderr.includes("E404")) return false;
	throw new Error(`npm view failed:\n${result.stderr}`);
}

/** A release stamps only what main already has, so HEAD must be origin/main exactly. */
function requireCleanMain() {
	if (git("branch", "--show-current") !== "main") throw new Error("Release from main.");
	if (git("status", "--porcelain", "--untracked-files=no")) {
		throw new Error("The worktree has uncommitted tracked changes.");
	}
	run("git", ["fetch", "--quiet", "origin", "main"]);
	const head = git("rev-parse", "HEAD");
	if (head !== git("rev-parse", "origin/main")) {
		throw new Error("HEAD is not origin/main. Push or pull main, wait for its CI, then release.");
	}
	return head;
}

/**
 * The release commit changes only the version and changelog, so the code it ships is the code
 * CI already passed on HEAD; refuse until that run has succeeded.
 */
function requirePassingCi(head) {
	const listed = gh([
		"run",
		"list",
		"--repo",
		githubRepository(),
		"--workflow",
		"publish-npm.yml",
		"--branch",
		"main",
		"--event",
		"push",
		"--commit",
		head,
		"--json",
		"status,conclusion,url",
	]);
	const runs = JSON.parse(listed.stdout || "[]");
	if (runs.some((ciRun) => ciRun.conclusion === "success")) return;
	const running = runs.find((ciRun) => ciRun.status !== "completed");
	if (running) throw new Error(`CI is still running on HEAD; release once it passes:\n  ${running.url}`);
	if (runs.length === 0) throw new Error("CI has not started on HEAD yet; release once it passes.");
	throw new Error(
		`CI did not pass on HEAD:\n  ${runs[0].url}\nFix main, or rerun the run if the failure was transient.`,
	);
}

async function confirm(question, yes) {
	if (yes) return true;
	if (!process.stdin.isTTY) throw new Error("Pass --yes to release without an interactive confirmation.");
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await readline.question(`${question} [y/N] `)).trim());
	} finally {
		readline.close();
	}
}

function printNextSteps(version) {
	console.log(`\nPushed the ${version} release. CI publishes this commit and tags it pi-v${version} once it passes:`);
	console.log(`  https://github.com/${githubRepository()}/actions/workflows/publish-npm.yml`);
	console.log(
		`If CI fails, nothing is published: rerun a transient failure, or fix main and run npm run release again for ${version}.`,
	);
}

async function release(requested, { dryRun, yes }) {
	requirePassingCi(requireCleanMain());
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const upstreamTag = JSON.parse(readFileSync(join(root, "maintainers", "upstream.json"), "utf8")).tag;
	// Only a release commit changes the version, so a version npm lacks is a release whose CI failed.
	const retry = !isPublished(packageJson.version);
	if (retry && requested && requested !== packageJson.version) {
		throw new Error(`${packageJson.version} never reached npm; release it again before ${requested}.`);
	}
	const version = retry ? packageJson.version : (requested ?? nextVersion(packageJson.version, upstreamTag));
	parseVersion(version);

	const changelogPath = join(root, "CHANGELOG.md");
	const lockfilePath = join(root, "package-lock.json");
	const date = new Date().toISOString().slice(0, 10);
	const text = readFileSync(changelogPath, "utf8");
	const changelog = retry ? restampChangelog(text, version, date) : stampChangelog(text, version, date);
	if (!retry && isPublished(version)) throw new Error(`${PACKAGE_NAME}@${version} is already on npm.`);

	if (dryRun) {
		const section = changelog.split(`## [${version}]`)[1].split("\n## ")[0];
		const again = retry ? " again, since its last release never reached npm" : "";
		console.log(`Would release ${PACKAGE_NAME}@${version}${again} (upstream ${upstreamTag}):\n`);
		console.log(`## [${version}]${section.trimEnd()}`);
		return;
	}

	if (!(await confirm(`Commit the ${version} release and push main? CI publishes it once it passes.`, yes))) {
		console.log("Release cancelled; no changes made.");
		return;
	}

	writeFileSync(changelogPath, changelog);
	if (!retry) {
		npm(["version", version, "--no-git-tag-version", "--ignore-scripts"], { capture: true });
		writeFileSync(lockfilePath, stampLockfile(readFileSync(lockfilePath, "utf8"), version));
	}
	run("git", ["add", "--", "CHANGELOG.md", "package.json", "package-lock.json"]);
	// A retry may change nothing; its commit still marks what CI publishes.
	run("git", ["commit", "--allow-empty", "-m", `chore: release ${version}`]);
	try {
		run("git", ["push", "origin", "main"]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\nThe release commit remains local. Fix the push problem, then run: git push origin main`,
		);
	}
	printNextSteps(version);
}

async function main(args) {
	const flags = new Set(args.filter((arg) => arg.startsWith("--")));
	const positional = args.filter((arg) => !arg.startsWith("--"));
	const known = ["--dry-run", "--yes"];
	if ([...flags].some((flag) => !known.includes(flag)) || positional.length > 1) {
		console.error(usage);
		return 2;
	}
	try {
		await release(positional[0]?.replace(/^v/, ""), {
			dryRun: flags.has("--dry-run"),
			yes: flags.has("--yes"),
		});
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
	process.exitCode = await main(process.argv.slice(2));
}
