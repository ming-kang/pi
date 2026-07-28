#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, gt, prerelease, valid } from "semver";
import { normalizeRepository } from "./diff-upstream-core.mjs";

const maxReportedNewerTags = 10;
const remoteGitTimeoutMs = 30_000;

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStableReleaseTag(tag) {
	if (typeof tag !== "string" || !tag.startsWith("v")) return undefined;
	const version = tag.slice(1);
	if (valid(version) !== version || prerelease(version) !== null) return undefined;
	return { tag, version };
}

export function parseRemoteTagRefs(output) {
	const tags = [];
	for (const line of output.split(/\r?\n/)) {
		const [objectId, ref, ...extra] = line.split("\t");
		if (!objectId || extra.length > 0 || !ref?.startsWith("refs/tags/")) continue;
		const tag = parseStableReleaseTag(ref.slice("refs/tags/".length));
		if (tag) tags.push(tag);
	}
	return tags.sort((first, second) => compare(first.version, second.version) || first.tag.localeCompare(second.tag));
}

export function readAuditBaseline(manifest) {
	if (!isPlainObject(manifest) || !isPlainObject(manifest.baseline)) {
		throw new Error("maintainers/upstream.json must contain a baseline object");
	}
	const repository = normalizeRepository(manifest.baseline.repository);
	if (!repository) {
		throw new Error("baseline.repository must be a canonical GitHub owner/repository pair");
	}
	const tag = parseStableReleaseTag(manifest.baseline.tag);
	if (!tag) {
		throw new Error("baseline.tag must be a stable v<semver> release tag");
	}
	return { repository, ...tag };
}

export function createReleaseReport(baseline, remoteTags) {
	const tags = [...remoteTags].sort(
		(first, second) => compare(first.version, second.version) || first.tag.localeCompare(second.tag),
	);
	const newerTags = tags.filter((tag) => gt(tag.version, baseline.version));
	const latestTag = tags.at(-1)?.tag;
	if (!latestTag) throw new Error("remote returned no stable release tags");

	const shownTags = newerTags.slice(-maxReportedNewerTags);
	const lines = [
		"## Upstream release audit",
		"",
		`- Reviewed baseline: \`${baseline.tag}\``,
		`- Stable upstream release tags: ${tags.length}`,
		`- Latest stable upstream tag: \`${latestTag}\``,
		`- Newer stable releases: ${newerTags.length} (informational only; no synchronization is performed)`,
	];
	if (shownTags.length > 0) {
		lines.push(`- Newer tags: ${shownTags.map((tag) => `\`${tag.tag}\``).join(", ")}`);
		if (shownTags.length < newerTags.length)
			lines.push(`- Older newer tags omitted: ${newerTags.length - shownTags.length}`);
	}

	return {
		latestTag,
		newerCount: newerTags.length,
		newerTags,
		outputs: { latest_tag: latestTag, newer_count: String(newerTags.length) },
		summary: lines.join("\n"),
	};
}

export function writeGithubAuditReport(report, { appendFile = appendFileSync, env = process.env } = {}) {
	if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${report.summary}\n`, "utf8");
	if (env.GITHUB_OUTPUT) {
		appendFile(
			env.GITHUB_OUTPUT,
			`newer_count=${report.outputs.newer_count}\nlatest_tag=${report.outputs.latest_tag}\n`,
			"utf8",
		);
	}
}

function executeGit(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: remoteGitTimeoutMs,
	});
}

export function discoverRemoteTagRefs(repository, runGit = executeGit) {
	return parseRemoteTagRefs(runGit(["ls-remote", "--tags", "--refs", `https://github.com/${repository}.git`]));
}

function writeLine(stream, value) {
	stream.write(`${value}\n`);
}

export function runUpstreamReleaseAudit({
	root = resolve(import.meta.dirname, ".."),
	stdout = process.stdout,
	stderr = process.stderr,
	readFile = readFileSync,
	runGit = executeGit,
	appendFile = appendFileSync,
	env = process.env,
} = {}) {
	try {
		const manifestPath = resolve(root, "maintainers", "upstream.json");
		const manifest = JSON.parse(readFile(manifestPath, "utf8"));
		const baseline = readAuditBaseline(manifest);
		const remoteTags = discoverRemoteTagRefs(baseline.repository, runGit);
		if (!remoteTags.some((tag) => tag.tag === baseline.tag)) {
			throw new Error(`baseline tag ${baseline.tag} is not present in remote stable release refs`);
		}
		const report = createReleaseReport(baseline, remoteTags);
		writeLine(stdout, report.summary);
		writeGithubAuditReport(report, { appendFile, env });
		return 0;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		writeLine(stderr, `Upstream release audit failed: ${detail}`);
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = runUpstreamReleaseAudit();
}
