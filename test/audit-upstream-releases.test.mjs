import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	createReleaseReport,
	parseRemoteTagRefs,
	parseStableReleaseTag,
	readAuditBaseline,
	runUpstreamReleaseAudit,
	writeGithubAuditReport,
} from "../scripts/audit-upstream-releases.mjs";

const temporaryDirectories = [];

function baseline(tag = "v1.2.3") {
	return { baseline: { repository: "Example/Repo", tag } };
}

function stream() {
	let text = "";
	return {
		value: () => text,
		write: (value) => {
			text += value;
		},
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("upstream release audit tag discovery", () => {
	test("accepts only stable v<semver> tags", () => {
		expect(parseStableReleaseTag("v1.2.3")).toEqual({ tag: "v1.2.3", version: "1.2.3" });
		for (const tag of ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-beta.1", "v1.2.3+build.1", "v 1.2.3"]) {
			expect(parseStableReleaseTag(tag)).toBeUndefined();
		}
	});

	test("filters remote refs and sorts stable releases by semver", () => {
		const refs = [
			"f".repeat(40) + "\trefs/tags/v1.10.0",
			"e".repeat(40) + "\trefs/tags/v1.2.3-rc.1",
			"d".repeat(40) + "\trefs/tags/release-1.3.0",
			"c".repeat(40) + "\trefs/tags/v0.9.0",
			"b".repeat(40) + "\trefs/tags/v1.2.3",
			"a".repeat(40) + "\trefs/tags/v1.2.3^{}",
		].join("\r\n");

		expect(parseRemoteTagRefs(refs).map((tag) => tag.tag)).toEqual(["v0.9.0", "v1.2.3", "v1.10.0"]);
	});
});

describe("upstream release audit reports", () => {
	test("reports newer tags as informational and exposes simple GitHub outputs", () => {
		const report = createReleaseReport(readAuditBaseline(baseline()), [
			{ tag: "v1.3.0", version: "1.3.0" },
			{ tag: "v1.2.3", version: "1.2.3" },
			{ tag: "v2.0.0", version: "2.0.0" },
		]);
		expect(report.newerTags.map((tag) => tag.tag)).toEqual(["v1.3.0", "v2.0.0"]);
		expect(report.outputs).toEqual({ latest_tag: "v2.0.0", newer_count: "2" });
		expect(report.summary).toContain("Newer stable releases: 2 (informational only; no synchronization is performed)");
		expect(report.summary).toContain("Newer tags: `v1.3.0`, `v2.0.0`");

		const directory = mkdtempSync(join(tmpdir(), "pi-upstream-audit-"));
		temporaryDirectories.push(directory);
		const summaryPath = join(directory, "summary.md");
		const outputPath = join(directory, "output.txt");
		writeGithubAuditReport(report, { env: { GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath } });
		expect(readFileSync(summaryPath, "utf8")).toBe(`${report.summary}\n`);
		expect(readFileSync(outputPath, "utf8")).toBe("newer_count=2\nlatest_tag=v2.0.0\n");
	});

	test("succeeds informatively when no stable release is newer than the baseline", () => {
		const stdout = stream();
		const stderr = stream();
		const code = runUpstreamReleaseAudit({
			stdout,
			stderr,
			readFile: () => JSON.stringify(baseline()),
			runGit: () => `${"a".repeat(40)}\trefs/tags/v1.2.2\n${"b".repeat(40)}\trefs/tags/v1.2.3\n`,
			env: {},
		});

		expect(code).toBe(0);
		expect(stderr.value()).toBe("");
		expect(stdout.value()).toContain("Newer stable releases: 0 (informational only; no synchronization is performed)");
		expect(stdout.value()).not.toContain("Newer tags:");
	});

	test("fails malformed or missing remote baselines but not newer releases", () => {
		expect(() => readAuditBaseline({ baseline: { repository: "not a repository", tag: "v1.2.3" } })).toThrow(
			"baseline.repository",
		);
		expect(() => readAuditBaseline(baseline("v1.2.3-beta.1"))).toThrow("baseline.tag");

		const stdout = stream();
		const stderr = stream();
		let gitArgs;
		const code = runUpstreamReleaseAudit({
			stdout,
			stderr,
			readFile: () => JSON.stringify(baseline()),
			runGit: (args) => {
				gitArgs = args;
				return `${"a".repeat(40)}\trefs/tags/v1.2.3\n${"b".repeat(40)}\trefs/tags/v1.2.4\n`;
			},
			env: {},
		});
		expect(code).toBe(0);
		expect(stderr.value()).toBe("");
		expect(stdout.value()).toContain("Newer stable releases: 1");
		expect(gitArgs).toEqual(["ls-remote", "--tags", "--refs", "https://github.com/example/repo.git"]);

		const missingBaseline = runUpstreamReleaseAudit({
			stdout: stream(),
			stderr,
			readFile: () => JSON.stringify(baseline()),
			runGit: () => `${"c".repeat(40)}\trefs/tags/v1.2.4\n`,
			env: {},
		});
		expect(missingBaseline).toBe(1);
		expect(stderr.value()).toContain("baseline tag v1.2.3 is not present");
	});
});
