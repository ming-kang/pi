import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyLockfileChanges } from "../scripts/check-lockfile-commit.mjs";
import { nextVersion, restampChangelog, stampChangelog, stampLockfile } from "../scripts/release.mjs";

const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function createReleaseFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-release-test-"));
	temporaryDirectories.push(directory);
	const root = join(directory, "work");
	const remote = join(directory, "origin.git");
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "maintainers"), { recursive: true });
	copyFileSync(resolve(import.meta.dirname, "../scripts/release.mjs"), join(root, "scripts/release.mjs"));

	writeJson(join(root, "package.json"), {
		name: "@astralyn/pi",
		version: "1.0.0",
		repository: { url: "https://github.com/example/pi" },
	});
	writeJson(join(root, "maintainers/upstream.json"), { tag: "v1.0.0" });
	writeJson(join(root, "package-lock.json"), { version: "1.0.0", packages: { "": { version: "1.0.0" } } });
	writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- Fixed a thing.\n");

	// The release script uses the same npm CLI as its parent. This local fixture
	// supplies the registry response and version bump without touching npm;
	// FAKE_NPM_PUBLISHED lists the versions npm has.
	const npmCli = join(root, "fake-npm.mjs");
	writeFileSync(
		npmCli,
		`import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] === "view") {
	const version = process.argv[3].split("@").pop();
	if ((process.env.FAKE_NPM_PUBLISHED ?? "").split(",").includes(version)) {
		console.log(version);
		process.exit(0);
	}
	console.error("npm error code E404");
	process.exit(1);
}
if (process.argv[2] === "version") {
	const path = new URL("./package.json", import.meta.url);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.version = process.argv[3];
	writeFileSync(path, JSON.stringify(manifest, null, "\\t") + "\\n");
	process.exit(0);
}
process.exit(2);
`,
	);
	// Stands in for the GitHub CLI: HEAD's CI run concluded as FAKE_CI_CONCLUSION says.
	const ghCli = join(directory, "fake-gh.mjs");
	writeFileSync(
		ghCli,
		`const conclusion = process.env.FAKE_CI_CONCLUSION ?? "success";
console.log(JSON.stringify([{ status: "completed", conclusion, url: "https://example.invalid/run" }]));
`,
	);

	git(root, "init", "--initial-branch=main");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "Release Test");
	git(root, "config", "core.hooksPath", ".git/no-hooks");
	git(root, "add", ".");
	git(root, "commit", "-m", "initial");
	git(directory, "init", "--bare", remote);
	git(root, "remote", "add", "origin", remote);
	git(root, "push", "--set-upstream", "origin", "main");
	return { root, npmCli, ghCli };
}

function runRelease({ root, npmCli, ghCli }, args = [], env = {}) {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_execpath"),
	);
	return spawnSync(process.execPath, [join(root, "scripts/release.mjs"), ...args], {
		cwd: root,
		env: { ...inherited, npm_execpath: npmCli, PI_RELEASE_GH: ghCli, FAKE_NPM_PUBLISHED: "1.0.0", ...env },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Commit an [Unreleased] entry and push it, as a fix after a failed release would land. */
function pushUnreleasedEntry(root, entry) {
	const path = join(root, "CHANGELOG.md");
	writeFileSync(path, readFileSync(path, "utf8").replace("## [Unreleased]\n", `## [Unreleased]\n\n${entry}\n`));
	git(root, "commit", "-am", "fix: an entry");
	git(root, "push", "origin", "main");
}

describe("release confirmation", () => {
	test("dry-run and a non-interactive release without --yes leave the repository unchanged", () => {
		const fixture = createReleaseFixture();
		const head = git(fixture.root, "rev-parse", "HEAD");
		const releaseFiles = ["CHANGELOG.md", "package.json", "package-lock.json"];
		const files = releaseFiles.map((file) => readFileSync(join(fixture.root, file), "utf8"));

		const preview = runRelease(fixture, ["--dry-run"]);
		expect(preview.status, preview.stderr).toBe(0);
		expect(preview.stdout).toContain("Would release @astralyn/pi@1.0.1");
		const release = runRelease(fixture);
		expect(release.status, release.stderr).toBe(1);
		expect(release.stderr).toContain("Pass --yes");

		expect(git(fixture.root, "rev-parse", "HEAD")).toBe(head);
		expect(git(fixture.root, "tag", "--list")).toBe("");
		expect(git(fixture.root, "status", "--porcelain")).toBe("");
		expect(releaseFiles.map((file) => readFileSync(join(fixture.root, file), "utf8"))).toEqual(files);
	});

	test("a confirmed release pushes its commit to main and leaves tagging to CI", () => {
		const fixture = createReleaseFixture();

		const release = runRelease(fixture, ["--yes"]);
		expect(release.status, release.stderr).toBe(0);

		expect(git(fixture.root, "log", "-1", "--format=%s")).toBe("chore: release 1.0.1");
		expect(git(fixture.root, "status", "--porcelain")).toBe("");
		expect(git(fixture.root, "ls-remote", "origin", "refs/heads/main").split("\t")[0]).toBe(
			git(fixture.root, "rev-parse", "HEAD"),
		);
		expect(git(fixture.root, "ls-remote", "--tags", "origin")).toBe("");
		expect(git(fixture.root, "tag", "--list")).toBe("");
		expect(JSON.parse(readFileSync(join(fixture.root, "package-lock.json"), "utf8")).version).toBe("1.0.1");
		expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toMatch(/## \[1\.0\.1\] - \d{4}-\d{2}-\d{2}\n\n- Fixed a thing\./);
	});

	test("releases only a pushed main whose CI passed", () => {
		const fixture = createReleaseFixture();
		const head = git(fixture.root, "rev-parse", "HEAD");

		const failed = runRelease(fixture, ["--yes"], { FAKE_CI_CONCLUSION: "failure" });
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("CI did not pass on HEAD");

		writeFileSync(join(fixture.root, "local.txt"), "not pushed\n");
		git(fixture.root, "add", "local.txt");
		git(fixture.root, "commit", "-m", "local");
		const unpushed = runRelease(fixture, ["--yes"]);
		expect(unpushed.status).toBe(1);
		expect(unpushed.stderr).toContain("HEAD is not origin/main");

		expect(git(fixture.root, "log", "--format=%s", `${head}..HEAD`)).toBe("local");
	});

	test("a release that never reached npm is released again as the same version", () => {
		const fixture = createReleaseFixture();
		expect(runRelease(fixture, ["--yes"]).status).toBe(0); // 1.0.1, whose CI then fails
		pushUnreleasedEntry(fixture.root, "- Fixed the release.");

		expect(runRelease(fixture, ["1.0.2", "--yes"]).stderr).toContain("1.0.1 never reached npm");
		const again = runRelease(fixture, ["--yes"]);
		expect(again.status, again.stderr).toBe(0);
		// A fix without a changelog entry still gets its own release commit.
		const empty = runRelease(fixture, ["--yes"]);
		expect(empty.status, empty.stderr).toBe(0);

		expect(git(fixture.root, "log", "--format=%s", "-3")).toBe(
			["chore: release 1.0.1", "chore: release 1.0.1", "fix: an entry"].join("\n"),
		);
		expect(JSON.parse(readFileSync(join(fixture.root, "package.json"), "utf8")).version).toBe("1.0.1");
		const changelog = readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8");
		expect(changelog).toMatch(
			/## \[Unreleased\]\n\n## \[1\.0\.1\] - \d{4}-\d{2}-\d{2}\n\n- Fixed a thing\.\n- Fixed the release\.\s*$/,
		);
	});
});

describe("nextVersion", () => {
	test("increments the patch within upstream's line and resets it on a newer line", () => {
		expect(nextVersion("1.0.5", "v1.0.4")).toBe("1.0.6");
		expect(nextVersion("1.0.5", "v1.0.9")).toBe("1.0.6");
		expect(nextVersion("1.0.5", "v1.1.0")).toBe("1.1.0");
		expect(nextVersion("1.9.3", "v2.0.1")).toBe("2.0.0");
	});
});

describe("stampChangelog", () => {
	const changelog = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"",
		"- Fixed a thing.",
		"",
		"## [1.0.5] - 2026-10-06",
		"",
		"- Older entry.",
		"",
	].join("\n");

	test("moves the unreleased entries under one new heading and leaves [Unreleased] empty", () => {
		const stamped = stampChangelog(changelog, "1.0.6", "2026-10-07");
		expect(stamped).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"## [1.0.6] - 2026-10-07",
				"",
				"### Fixed",
				"",
				"- Fixed a thing.",
				"",
				"## [1.0.5] - 2026-10-06",
				"",
				"- Older entry.",
				"",
			].join("\n"),
		);
	});

	test("refuses an empty [Unreleased] and an existing release heading", () => {
		const stamped = stampChangelog(changelog, "1.0.6", "2026-10-07");
		expect(() => stampChangelog(stamped, "1.0.7", "2026-10-08")).toThrow("nothing to release");
		expect(() => stampChangelog(changelog, "1.0.5", "2026-10-08")).toThrow("already has a heading");
	});
});

describe("restampChangelog", () => {
	test("folds new entries into the unpublished release's matching groups and dates it again", () => {
		const changelog = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Added a page.",
			"",
			"### Fixed",
			"",
			"- Fixed the release.",
			"",
			"## [1.0.6] - 2026-10-07",
			"",
			"### Fixed",
			"",
			"- Fixed a thing.",
			"",
			"## [1.0.5] - 2026-10-06",
			"",
			"- Older entry.",
			"",
		].join("\n");
		expect(restampChangelog(changelog, "1.0.6", "2026-10-08")).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"## [1.0.6] - 2026-10-08",
				"",
				"### Fixed",
				"",
				"- Fixed a thing.",
				"- Fixed the release.",
				"",
				"### Added",
				"",
				"- Added a page.",
				"",
				"## [1.0.5] - 2026-10-06",
				"",
				"- Older entry.",
				"",
			].join("\n"),
		);
		expect(() => restampChangelog(changelog, "1.0.5", "2026-10-08")).toThrow("newest release is not 1.0.5");
	});
});

describe("stampLockfile", () => {
	const lock = `${JSON.stringify(
		{
			name: "@astralyn/pi",
			version: "1.3.0",
			lockfileVersion: 3,
			packages: {
				"": { name: "@astralyn/pi", version: "1.3.0", dependencies: { chalk: "6.0.0" } },
				"node_modules/chalk": { version: "6.0.0" },
			},
		},
		null,
		"\t",
	)}\n`;

	test("moves both root version copies and leaves every other lockfile entry untouched", () => {
		const stamped = stampLockfile(lock, "1.3.1");
		expect(stamped).toBe(lock.replaceAll('"1.3.0"', '"1.3.1"'));
		expect(JSON.parse(stamped).packages["node_modules/chalk"]).toEqual({ version: "6.0.0" });
	});
});

describe("classifyLockfileChanges", () => {
	const lock = (version, upstream, extra = {}) => ({
		name: "@astralyn/pi",
		version,
		lockfileVersion: 3,
		packages: {
			"": { name: "@astralyn/pi", version, dependencies: { "@earendil-works/pi-ai": upstream, chalk: "6.0.0" } },
			"node_modules/@earendil-works/pi-ai": { version: upstream, integrity: `sha-${upstream}` },
			"node_modules/chalk": { version: "6.0.0" },
			...extra,
		},
	});

	test("accepts a release version bump and an upstream package bump without acknowledgement", () => {
		expect(classifyLockfileChanges(lock("1.0.5", "1.0.4"), lock("1.0.6", "1.0.4"), "1.0.4").routine).toBe(true);
		expect(classifyLockfileChanges(lock("1.0.5", "1.0.4"), lock("1.0.5", "1.0.5"), "1.0.5").routine).toBe(true);
	});

	test("requires acknowledgement when a third-party package changes alongside an upstream bump", () => {
		const after = lock("1.0.5", "1.0.5", { "node_modules/chalk": { version: "6.0.1" } });
		const result = classifyLockfileChanges(lock("1.0.5", "1.0.4"), after, "1.0.5");
		expect(result.routine).toBe(false);
		expect(result.summary).toContain("changed chalk 6.0.0 -> 6.0.1");

		const added = lock("1.0.5", "1.0.5", { "node_modules/@earendil-works/pi-ai/node_modules/left-pad": { version: "1.0.0" } });
		expect(classifyLockfileChanges(lock("1.0.5", "1.0.4"), added, "1.0.5").routine).toBe(false);
	});

	test("requires acknowledgement when upstream packages move to a version other than the baseline", () => {
		expect(classifyLockfileChanges(lock("1.0.5", "1.0.4"), lock("1.0.5", "1.0.6"), "1.0.5").routine).toBe(false);
	});
});
