import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	normalizeRepository,
	runDiffUpstream,
	validateManifest,
} from "../scripts/diff-upstream.mjs";

const runtimeDependencies = {
	"@earendil-works/pi-agent-core": "1.2.3",
	"@earendil-works/pi-ai": "1.2.3",
	"@earendil-works/pi-tui": "1.2.3",
};

const temporaryDirectories = [];

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function baseManifest() {
	return {
		repository: "example/repo",
		tag: "v1.2.3",
		commit: "a".repeat(40),
		sourceSubtree: "packages/coding-agent",
		sourceTree: "b".repeat(40),
	};
}

function createTestRepo({ sourceDependencies = runtimeDependencies } = {}) {
	const root = join(tmpdir(), `pi-diff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(root);
	mkdirSync(root, { recursive: true });

	git(root, "init");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "Diff Test");
	git(root, "config", "core.autocrlf", "false");

	const sourceDir = join(root, "packages", "coding-agent");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePackage = { name: "test-agent", version: "1.2.3", dependencies: sourceDependencies };
	writeJson(join(sourceDir, "package.json"), sourcePackage);
	for (const name of ["mod.txt", "drop.txt"]) {
		writeFileSync(join(sourceDir, name), `${name}\n`);
	}
	writeFileSync(join(sourceDir, ".gitignore"), "maintainers/\nignored.txt\n");

	git(root, "add", "packages");
	git(root, "commit", "-m", "upstream release");
	git(root, "tag", "v1.2.3");
	const commit = git(root, "rev-parse", "v1.2.3^{commit}");
	const sourceTree = git(root, "rev-parse", "v1.2.3:packages/coding-agent");

	rmSync(join(root, "packages"), { recursive: true });
	const localPackage = { name: "test-agent", version: "1.2.3", dependencies: runtimeDependencies };
	writeJson(join(root, "package.json"), localPackage);
	for (const name of ["mod.txt", "drop.txt"]) {
		writeFileSync(join(root, name), `${name}\n`);
	}
	writeFileSync(join(root, ".gitignore"), "maintainers/\nignored.txt\n");

	git(root, "add", "-A");
	git(root, "commit", "-m", "root mapped");

	const manifest = baseManifest();
	manifest.commit = commit;
	manifest.sourceTree = sourceTree;
	writeJson(join(root, "maintainers", "upstream.json"), manifest);
	writeJson(join(root, "maintainers", "deltas.json"), { deltas: [] });

	writeJson(join(root, "npm-shrinkwrap.json"), {
		lockfileVersion: 3,
		packages: {
			"": { dependencies: runtimeDependencies },
			...Object.fromEntries(
				Object.entries(runtimeDependencies).map(([name, version]) => [`node_modules/${name}`, { version }]),
			),
		},
	});

	return { root, manifest, commit, sourceTree };
}

function invoke(root, args = []) {
	let stdout = "";
	let stderr = "";
	const code = runDiffUpstream({
		root,
		args,
		stdout: { write: (t) => (stdout += t) },
		stderr: { write: (t) => (stderr += t) },
	});
	return { code, stdout, stderr };
}

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
});

describe("diff-upstream manifest and dependency validation", () => {
	test("normalizes repository and validates lean manifest schema", () => {
		expect(normalizeRepository("Example/Repo")).toBe("example/repo");
		expect(normalizeRepository("invalid")).toBeUndefined();

		const valid = validateManifest(baseManifest());
		expect(valid).toHaveLength(0);

		const invalid = validateManifest({ ...baseManifest(), extra: true });
		expect(invalid.join("\n")).toContain("unexpected key");

		const missing = validateManifest({ repository: "example/repo" });
		expect(missing.join("\n")).toContain("missing required key");

		const prereleaseTag = validateManifest({ ...baseManifest(), tag: "v1.2.3-alpha.1" });
		expect(prereleaseTag.join("\n")).toContain("exact stable release tag");

		const missingVTag = validateManifest({ ...baseManifest(), tag: "1.2.3" });
		expect(missingVTag.join("\n")).toContain("exact stable release tag");

		for (const invalidSubtree of [".", "..", "../packages", "packages/.", "packages/..", "packages/./coding-agent"]) {
			const res = validateManifest({ ...baseManifest(), sourceSubtree: invalidSubtree });
			expect(res.join("\n")).toContain("exact canonical POSIX path");
		}
	});

	test("detects baseline package version mismatch and missing or invalid dependency ranges", () => {
		const repo = createTestRepo();
		writeJson(join(repo.root, "v124", "package.json"), {
			name: "test-agent",
			version: "1.2.4",
			dependencies: runtimeDependencies,
		});
		git(repo.root, "add", "v124");
		git(repo.root, "commit", "-m", "v124");
		repo.manifest.sourceTree = git(repo.root, "rev-parse", "HEAD:v124");
		writeJson(join(repo.root, "maintainers", "upstream.json"), repo.manifest);
		git(repo.root, "tag", "-d", "v1.2.3");

		const mismatchRes = invoke(repo.root, ["--check"]);
		expect(mismatchRes.code).toBe(1);
		expect(mismatchRes.stderr).toContain("does not match manifest tag");

		const missingDepRepo = createTestRepo({
			sourceDependencies: { "@earendil-works/pi-agent-core": "1.2.3" },
		});
		const missingDepRes = invoke(missingDepRepo.root, ["--check"]);
		expect(missingDepRes.code).toBe(1);
		expect(missingDepRes.stderr).toContain("must be a valid semver range");

		const nonObjectRepo = createTestRepo();
		writeFileSync(join(nonObjectRepo.root, "package.json"), "[]\n");
		const nonObjectRes = invoke(nonObjectRepo.root, ["--check"]);
		expect(nonObjectRes.code).toBe(1);
		expect(nonObjectRes.stderr).toContain("package.json must be a JSON object");
	});

	test("detects dependency mismatch between package.json, shrinkwrap, and upstream range", () => {
		const repo = createTestRepo({ sourceDependencies: { ...runtimeDependencies, "@earendil-works/pi-ai": "^2.0.0" } });
		const result = invoke(repo.root, ["--check"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not satisfy upstream coding-agent range");
	});
});

describe("diff-upstream worktree collection and CLI execution", () => {
	test("collects staged, unstaged, and untracked changes into M, A, D groups", () => {
		const repo = createTestRepo();
		writeFileSync(join(repo.root, "mod.txt"), "modified content\n");
		git(repo.root, "add", "mod.txt");
		rmSync(join(repo.root, "drop.txt"));
		writeFileSync(join(repo.root, "add.txt"), "new file\n");
		writeFileSync(join(repo.root, "ignored.txt"), "ignored file\n");

		const result = invoke(repo.root);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("M mod.txt");
		expect(result.stdout).toContain("A add.txt");
		expect(result.stdout).toContain("D drop.txt");
		expect(result.stdout).not.toContain("ignored.txt");

		// M/D deviations without ledger entries fail the check gate.
		const unregistered = invoke(repo.root, ["--check"]);
		expect(unregistered.code).toBe(1);
		expect(unregistered.stderr).toContain("unregistered upstream deviation: M mod.txt");
		expect(unregistered.stderr).toContain("unregistered upstream deviation: D drop.txt");

		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [
				{ path: "drop.txt", category: "distribution", intent: "Dropped file", tests: [], status: "verified" },
				{ path: "mod.txt", category: "ui", intent: "Modified file", tests: [], status: "unverified" },
			],
		});
		const checkResult = invoke(repo.root, ["--check"]);
		expect(checkResult.code).toBe(0);
		expect(checkResult.stdout).toContain("Verified 4 worktree differences against v1.2.3");
		expect(checkResult.stdout).toContain("2 registered deltas (1 unverified)");
	});

	test("verifies tag and tree integrity and falls back gracefully if tag is missing locally", () => {
		const repo = createTestRepo();
		git(repo.root, "tag", "-d", "v1.2.3");

		const fallback = invoke(repo.root, ["--check"]);
		expect(fallback.code).toBe(0);
		expect(fallback.stderr).toContain("tag v1.2.3 is unavailable locally");

		const mismatch = createTestRepo();
		mismatch.manifest.commit = "c".repeat(40);
		writeJson(join(mismatch.root, "maintainers", "upstream.json"), mismatch.manifest);
		const mismatchResult = invoke(mismatch.root, ["--check"]);
		expect(mismatchResult.code).toBe(1);
		expect(mismatchResult.stderr).toContain("does not match tag");
	});

	test("rejects invalid or unknown CLI flags with exit code 2", () => {
		const repo = createTestRepo();
		const result = invoke(repo.root, ["--invalid"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Usage:");
	});
});

describe("diff-upstream deviation ledger", () => {
	test("annotates registered deviations and supports directory-prefix entries", () => {
		const repo = createTestRepo();
		writeFileSync(join(repo.root, "mod.txt"), "modified content\n");
		mkdirSync(join(repo.root, "docs"));
		writeFileSync(join(repo.root, "docs", "extra.md"), "doc\n");
		git(repo.root, "add", "-A");
		git(repo.root, "commit", "-m", "local docs baseline");
		// Rewrite an upstream-tracked path inside the prefix by re-creating the
		// baseline diff: docs/extra.md is an addition, so only mod.txt is M.
		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [{ path: "mod.txt", category: "windows-compat", intent: "Rewrites the file", tests: [], status: "verified" }],
		});

		const report = invoke(repo.root);
		expect(report.code).toBe(0);
		expect(report.stdout).toContain("M mod.txt  [windows-compat, verified] Rewrites the file");
		expect(report.stdout).toContain("1 registered deltas (0 unverified)");
	});

	test("prefix entries cover whole directories and stale entries fail the check", () => {
		const repo = createTestRepo();
		mkdirSync(join(repo.root, "sub"));
		// No deviation matches the prefix, so the entry is stale.
		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [{ path: "sub/", category: "distribution", intent: "Distribution area", tests: [], status: "verified" }],
		});
		const stale = invoke(repo.root, ["--check"]);
		expect(stale.code).toBe(1);
		expect(stale.stderr).toContain("stale delta entry");

		// A modified file under the prefix is covered by the prefix entry.
		writeFileSync(join(repo.root, "mod.txt"), "changed\n");
		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [{ path: "mod.txt", category: "bugfix", intent: "Covered", tests: [], status: "verified" }],
		});
		const covered = invoke(repo.root, ["--check"]);
		expect(covered.code).toBe(0);

		const reportStale = invoke(repo.root);
		expect(reportStale.code).toBe(0);
	});

	test("rejects schema violations: unknown category, missing intent, duplicates, missing tests, unsorted", () => {
		const repo = createTestRepo();
		writeFileSync(join(repo.root, "mod.txt"), "changed\n");

		const cases = [
			[{ path: "mod.txt", category: "nope", intent: "x", tests: [], status: "verified" }, "category must be one of"],
			[{ path: "mod.txt", category: "ui", intent: "", tests: [], status: "verified" }, "intent must be a non-empty string"],
			[{ path: "mod.txt", category: "ui", intent: "x", tests: ["test/missing.test.ts"], status: "verified" }, "does not exist"],
			[{ path: "mod.txt", category: "ui", intent: "x", tests: [], status: "maybe" }, "status must be one of"],
			[{ path: "mod.txt", category: "ui", intent: "x", tests: [], status: "verified", extra: 1 }, 'unexpected key "extra"'],
		];
		for (const [entry, expected] of cases) {
			writeJson(join(repo.root, "maintainers", "deltas.json"), { deltas: [entry] });
			const result = invoke(repo.root, ["--check"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(expected);
		}

		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [
				{ path: "mod.txt", category: "ui", intent: "x", tests: [], status: "verified" },
				{ path: "mod.txt", category: "ui", intent: "x", tests: [], status: "verified" },
			],
		});
		const duplicate = invoke(repo.root, ["--check"]);
		expect(duplicate.code).toBe(1);
		expect(duplicate.stderr).toContain("duplicate path");

		writeJson(join(repo.root, "maintainers", "deltas.json"), {
			deltas: [
				{ path: "zzz.txt", category: "ui", intent: "x", tests: [], status: "verified" },
				{ path: "mod.txt", category: "ui", intent: "x", tests: [], status: "verified" },
			],
		});
		const unsorted = invoke(repo.root, ["--check"]);
		expect(unsorted.code).toBe(1);
		expect(unsorted.stderr).toContain("sorted by path");
	});

	test("missing ledger keeps the report usable but fails the check", () => {
		const repo = createTestRepo();
		rmSync(join(repo.root, "maintainers", "deltas.json"));

		const report = invoke(repo.root);
		expect(report.code).toBe(0);
		expect(report.stderr).toContain("maintainers/deltas.json is missing");

		const check = invoke(repo.root, ["--check"]);
		expect(check.code).toBe(1);
		expect(check.stderr).toContain("maintainers/deltas.json is missing");
	});
});
