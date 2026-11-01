#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const usage = `Usage: npm run release -- [<version>] [--dry-run] [--yes]

  (default)  validate and confirm the release, stamp CHANGELOG [Unreleased], bump the version,
             commit, tag pi-v<version>, and push main and the tag together atomically;
             the tag's workflow verifies and publishes
  <version>  release this version instead of the next one in upstream's major.minor line
  --dry-run  print the version and changelog section without asking or changing anything
  --yes      create and push the release without asking`;

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

function isPublished(version) {
	const result = npm(["view", `${PACKAGE_NAME}@${version}`, "version", "--registry=https://registry.npmjs.org"], {
		capture: true,
		allowFailure: true,
	});
	if (result.ok) return result.stdout !== "";
	if (result.stderr.includes("E404")) return false;
	throw new Error(`npm view failed:\n${result.stderr}`);
}

function requireCleanMain() {
	if (git("branch", "--show-current") !== "main") throw new Error("Release from main.");
	if (git("status", "--porcelain", "--untracked-files=no")) {
		throw new Error("The worktree has uncommitted tracked changes.");
	}
	run("git", ["fetch", "--quiet", "origin", "main"]);
	if (!run("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { allowFailure: true }).ok) {
		throw new Error("origin/main has commits that HEAD lacks; pull them first.");
	}
}

async function confirm(question, yes) {
	if (yes) return true;
	if (!process.stdin.isTTY)
		throw new Error("Pass --yes to create and push a release without an interactive confirmation.");
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await readline.question(`${question} [y/N] `)).trim());
	} finally {
		readline.close();
	}
}

// gh resolves its default repository from the remotes, which here include
// upstream, so name this distribution's repository explicitly.
function printWatch(tag) {
	const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const repo = new URL(repository.url).pathname.replace(/^\//, "").replace(/\.git$/, "");
	console.log(`\nThe tag runs the Publish npm workflow: full CI, then publication of the verified tarball.`);
	console.log(`  gh run list --repo ${repo} --workflow publish-npm.yml --branch ${tag} --limit 1`);
	console.log(`  gh run watch <run-id> --repo ${repo} --exit-status`);
}

async function release(requested, { dryRun, yes }) {
	requireCleanMain();
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const upstreamTag = JSON.parse(readFileSync(join(root, "maintainers", "upstream.json"), "utf8")).tag;
	const version = requested ?? nextVersion(packageJson.version, upstreamTag);
	parseVersion(version);
	const tag = `pi-v${version}`;

	const changelogPath = join(root, "CHANGELOG.md");
	const lockfilePath = join(root, "package-lock.json");
	const date = new Date().toISOString().slice(0, 10);
	const changelog = stampChangelog(readFileSync(changelogPath, "utf8"), version, date);
	if (isPublished(version)) throw new Error(`${PACKAGE_NAME}@${version} is already on npm.`);
	if (git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
		throw new Error(`Tag ${tag} already exists.`);
	}

	if (dryRun) {
		const section = changelog.split(`## [${version}]`)[1].split("\n## ")[0];
		console.log(`Would release ${PACKAGE_NAME}@${version} (upstream ${upstreamTag}) as ${tag}:\n`);
		console.log(`## [${version}]${section.trimEnd()}`);
		return;
	}

	const push = ["push", "--atomic", "origin", "main", `refs/tags/${tag}`];
	if (
		!(await confirm(`Create release commit and ${tag}, then push both to origin, which publishes ${version}?`, yes))
	) {
		console.log("Release cancelled; no changes made.");
		return;
	}

	writeFileSync(changelogPath, changelog);
	npm(["version", version, "--no-git-tag-version", "--ignore-scripts"], { capture: true });
	writeFileSync(lockfilePath, stampLockfile(readFileSync(lockfilePath, "utf8"), version));
	run("git", ["add", "--", "CHANGELOG.md", "package.json", "package-lock.json"]);
	run("git", ["commit", "-m", `chore: release ${version}`]);
	run("git", ["tag", "-a", tag, "-m", `${PACKAGE_NAME} ${version}`]);

	try {
		run("git", push);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\nThe release commit and ${tag} remain local. Fix the push problem, then retry with:\n  git ${push.join(" ")}`,
		);
	}
	printWatch(tag);
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
