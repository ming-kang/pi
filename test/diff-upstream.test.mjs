import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	buildBudgetMetrics,
	classifyEntries,
	enforceBudget,
	isCanonicalPosixPath,
	normalizeGithubRepository,
	parseOwnedPattern,
	parseRemoteNames,
	runDiffUpstream,
	validateManifest,
} from "../scripts/diff-upstream-core.mjs";

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
		schemaVersion: 3,
		baseline: {
			repository: "example/repo",
			tag: "v1.2.3",
			commit: "a".repeat(40),
			sourceSubtree: "packages/coding-agent",
			sourceTree: "b".repeat(40),
			codingAgentVersion: "1.2.3",
			runtimeDependencies,
		},
		budget: {
			hybridPathCeiling: 0,
			hybridSourcePathCeiling: 0,
			droppedPathCeiling: 0,
			deltaUnitCeiling: 0,
			highRiskUnitCeiling: 0,
			privateUpstreamAssumptionCeiling: 0,
		},
		owned: { overlays: [], additions: [] },
		deltas: [],
	};
}

function delta(id, modified = [], dropped = [], overrides = {}) {
	return {
		id,
		title: `Title ${id}`,
		disposition: "keep",
		risk: "low",
		privateUpstreamAssumptions: [],
		modified,
		dropped,
		...overrides,
	};
}

function createRepository({ sourceDependencies = runtimeDependencies } = {}) {
	const root = join(tmpdir(), `pi-diff-upstream-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(root);
	mkdirSync(root, { recursive: true });
	git(root, "init");
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "Diff Upstream Test");
	git(root, "config", "core.autocrlf", "false");
	git(root, "remote", "add", "upstream", "https://github.com/Example/Repo.git");

	const source = join(root, "packages", "coding-agent");
	mkdirSync(source, { recursive: true });
	const sourcePackage = { name: "test-agent", version: "1.2.3", dependencies: sourceDependencies };
	writeJson(join(source, "package.json"), sourcePackage);
	for (const name of ["first.txt", "second.txt", "tracked.txt", "drop.txt"]) writeFileSync(join(source, name), `${name}\n`);
	writeFileSync(join(source, ".gitignore"), "maintainers/\nignored.txt\n");
	git(root, "add", "packages");
	git(root, "commit", "-m", "upstream source");
	git(root, "tag", "v1.2.3");
	const commit = git(root, "rev-parse", "v1.2.3^{commit}");
	const sourceTree = git(root, "rev-parse", "v1.2.3:packages/coding-agent");

	rmSync(join(root, "packages"), { recursive: true });
	writeJson(join(root, "package.json"), sourcePackage);
	for (const name of ["first.txt", "second.txt", "tracked.txt", "drop.txt"]) writeFileSync(join(root, name), `${name}\n`);
	writeFileSync(join(root, ".gitignore"), "maintainers/\nignored.txt\n");
	git(root, "add", "-A");
	git(root, "commit", "-m", "root mapped source");

	const manifest = baseManifest();
	manifest.baseline.commit = commit;
	manifest.baseline.sourceTree = sourceTree;
	manifest.owned.additions = ["npm-shrinkwrap.json"];
	writeJson(join(root, "maintainers", "upstream.json"), manifest);
	writeJson(join(root, "npm-shrinkwrap.json"), {
		lockfileVersion: 3,
		packages: {
			"": { dependencies: runtimeDependencies },
			...Object.fromEntries(
				Object.entries(runtimeDependencies).map(([name, version]) => [`node_modules/${name}`, { version }]),
			),
		},
	});
	return { root, manifest };
}

function invoke(root, args = []) {
	let stdout = "";
	let stderr = "";
	const code = runDiffUpstream({
		root,
		args,
		stdout: { write: (text) => (stdout += text) },
		stderr: { write: (text) => (stderr += text) },
	});
	return { code, stdout, stderr };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

describe("diff-upstream manifest and classification", () => {
	test("rejects schema typos, invalid values, duplicates, empty units, and unsupported dispositions", () => {
		const manifest = baseManifest();
		manifest.schemaVersion = 2;
		manifest.unexpected = true;
		delete manifest.baseline.sourceSubtree;
		manifest.baseline.tag = "bad tag";
		manifest.baseline.commit = "A".repeat(40);
		manifest.baseline.sourceTree = "C".repeat(40);
		manifest.baseline.codingAgentVersion = "1.2.3-beta.1";
		manifest.baseline.extra = true;
		manifest.owned.overlays = ["src\\bad", "same", "same"];
		manifest.deltas = [
			delta("Bad_ID", ["src/**"], ["drop/**"], {
				title: "Repeated",
				disposition: "remove",
				risk: "critical",
				privateUpstreamAssumptions: ["private", "private"],
			}),
			delta("Bad_ID", [], [], { title: "Repeated" }),
		];
		const failures = validateManifest(manifest).failures.join("\n");
		expect(failures).toContain("schemaVersion");
		expect(failures).toContain("unknown key unexpected");
		expect(failures).toContain("missing required key sourceSubtree");
		expect(failures).toContain("unknown key extra");
		expect(failures).toContain("canonical Git tag name");
		expect(failures).toContain("lowercase 40-hex");
		expect(failures).toContain("exact stable semver");
		expect(failures).toContain("lower-kebab");
		expect(failures).toContain("one of keep, isolate, upstream");
		expect(failures).toContain("one of low, medium, high");
		expect(failures).toContain("duplicates delta unit ID");
		expect(failures).toContain("duplicates delta unit title");
		expect(failures).toContain("duplicates private upstream assumption");
		expect(failures).toContain("must register at least one");
	});

	test("enforces canonical exact paths, owned subtree rules, and static overlap prevention", () => {
		expect(isCanonicalPosixPath("src/file.ts")).toBe(true);
		expect(isCanonicalPosixPath("src/../file.ts")).toBe(false);
		expect(isCanonicalPosixPath("src\\file.ts")).toBe(false);
		expect(parseOwnedPattern("docs/**")).toMatchObject({ base: "docs", isSubtree: true });
		const manifest = baseManifest();
		manifest.owned.additions = ["docs/**", "docs/guide.md"];
		manifest.deltas = [delta("one", ["src/**"], ["deleted/**"]), delta("two", ["same.txt"]), delta("three", ["same.txt"])];
		const failures = validateManifest(manifest).failures.join("\n");
		expect(failures).toContain("without glob syntax");
		expect(failures).toContain("overlaps or shadows");
		expect(failures).toContain("duplicates path");
	});

	test("classifies overlays, additions, modifications, drops, unregistered, stale, and ambiguous paths", () => {
		const rules = [
			{ base: "overlay", isSubtree: true, location: "owned.overlays[0]", pattern: "overlay/**", ruleKind: "owned overlay" },
			{ base: "addition", isSubtree: false, location: "owned.additions[0]", pattern: "addition", ruleKind: "owned addition" },
			{ base: "modified", isSubtree: false, location: "deltas[0].modified[0]", pattern: "modified", ruleKind: "hybrid" },
			{ base: "dropped", isSubtree: false, location: "deltas[0].dropped[0]", pattern: "dropped", ruleKind: "dropped" },
			{ base: "stale", isSubtree: false, location: "owned.additions[1]", pattern: "stale", ruleKind: "owned addition" },
		];
		const failures = [];
		const changes = classifyEntries(
			[
				{ path: "overlay/a", status: "A" },
				{ path: "overlay/m", status: "M" },
				{ path: "overlay/d", status: "D" },
				{ path: "addition", status: "A" },
				{ path: "modified", status: "M" },
				{ path: "dropped", status: "D" },
				{ path: "unknown", status: "M" },
			],
			rules,
			failures,
		);
		expect(changes.ownedChanges).toHaveLength(4);
		expect(changes.hybridChanges).toHaveLength(1);
		expect(changes.droppedChanges).toHaveLength(1);
		expect(changes.unregisteredChanges).toHaveLength(1);
		expect(failures.join("\n")).toContain("unregistered local modification");
		expect(failures.join("\n")).toContain("matches no difference");
		for (const { expectedStatus, invalidStatuses, rule } of [
			{ rule: rules[1], expectedStatus: "A", invalidStatuses: ["M", "D"] },
			{ rule: rules[2], expectedStatus: "M", invalidStatuses: ["A", "D"] },
			{ rule: rules[3], expectedStatus: "D", invalidStatuses: ["A", "M"] },
		]) {
			for (const status of invalidStatuses) {
				const invalidFailures = [];
				classifyEntries([{ path: rule.base, status }], [rule], invalidFailures);
				expect(invalidFailures.join("\n")).toContain(
					`${rule.ruleKind} rule ${rule.location} (${rule.pattern}) requires ${expectedStatus} status, found ${status}: ${rule.base}`,
				);
			}
		}
		const ambiguousFailures = [];
		classifyEntries(
			[{ path: "duplicate", status: "A" }],
			[{ ...rules[1], base: "duplicate", pattern: "duplicate" }, { ...rules[1], base: "duplicate", pattern: "duplicate", location: "other" }],
			ambiguousFailures,
		);
		expect(ambiguousFailures.join("\n")).toContain("ambiguous registry match");
	});

	test("accounts for all six budget metrics and rejects growth, ratchet misses, and mismatches", () => {
		const record = baseManifest();
		record.deltas = [delta("high", ["src/a.ts"], ["gone.txt"], { risk: "high", privateUpstreamAssumptions: ["private"] }), delta("low", ["other.txt"])];
		const rules = [
			{ base: "src/a.ts", ruleKind: "hybrid" },
			{ base: "other.txt", ruleKind: "hybrid" },
			{ base: "gone.txt", ruleKind: "dropped" },
		];
		const changes = { hybridChanges: [{ path: "src/a.ts" }, { path: "other.txt" }], droppedChanges: [{ path: "gone.txt" }], ownedChanges: [], unregisteredChanges: [] };
		record.budget = { hybridPathCeiling: 2, hybridSourcePathCeiling: 1, droppedPathCeiling: 1, deltaUnitCeiling: 2, highRiskUnitCeiling: 1, privateUpstreamAssumptionCeiling: 1 };
		const metrics = buildBudgetMetrics(record, rules, changes);
		expect(metrics).toHaveLength(6);
		const success = [];
		enforceBudget(metrics, record.budget, success);
		expect(success).toEqual([]);
		const failures = [];
		enforceBudget([{ actual: 3, registered: 3, budgetKey: "hybridPathCeiling", label: "hybrid paths" }, { actual: 0, registered: 0, budgetKey: "droppedPathCeiling", label: "dropped paths" }, { actual: 2, registered: 1, budgetKey: "deltaUnitCeiling", label: "delta units" }], { hybridPathCeiling: 2, droppedPathCeiling: 1, deltaUnitCeiling: 1 }, failures);
		expect(failures.join("\n")).toContain("grows the delta");
		expect(failures.join("\n")).toContain("Ratchet the ceiling down");
		expect(failures.join("\n")).toContain("actual 2, registered 1");
	});

	test("normalizes HTTPS and SSH remotes and accepts CRLF remote lists", () => {
		expect(normalizeGithubRepository("https://GitHub.com/Example/Repo.git")).toBe("example/repo");
		expect(normalizeGithubRepository("git@github.com:Example/Repo.git")).toBe("example/repo");
		expect(normalizeGithubRepository("https://example.invalid/example/repo")).toBeUndefined();
		expect(parseRemoteNames("origin\r\nupstream\r\n")).toEqual(["origin", "upstream"]);
	});
});

describe("diff-upstream temporary Git repositories", () => {
	test("passes a synthetic exact-baseline worktree with zero delta", () => {
		const { root, manifest } = createRepository();
		manifest.owned = { overlays: [], additions: [] };
		manifest.deltas = [];
		manifest.budget = {
			hybridPathCeiling: 0,
			hybridSourcePathCeiling: 0,
			droppedPathCeiling: 0,
			deltaUnitCeiling: 0,
			highRiskUnitCeiling: 0,
			privateUpstreamAssumptionCeiling: 0,
		};
		writeJson(join(root, "maintainers", "upstream.json"), manifest);
		writeFileSync(join(root, ".git", "info", "exclude"), "maintainers/\nnpm-shrinkwrap.json\n");

		const result = invoke(root, ["--check"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Verified 0 worktree differences");
	});

	test("collects staged, unstaged, nonignored untracked changes in deterministic order and rejects tracked/untracked conflicts", () => {
		const { root, manifest } = createRepository();
		manifest.owned.additions.push("owned/**");
		manifest.deltas = [delta("changes", ["first.txt", "second.txt"])];
		manifest.budget = { hybridPathCeiling: 2, hybridSourcePathCeiling: 0, droppedPathCeiling: 0, deltaUnitCeiling: 1, highRiskUnitCeiling: 0, privateUpstreamAssumptionCeiling: 0 };
		writeJson(join(root, "maintainers", "upstream.json"), manifest);
		writeFileSync(join(root, "first.txt"), "staged\n");
		git(root, "add", "first.txt");
		writeFileSync(join(root, "second.txt"), "unstaged\n");
		mkdirSync(join(root, "owned"));
		writeFileSync(join(root, "owned", "z.txt"), "owned\n");
		writeFileSync(join(root, "ignored.txt"), "ignored\n");
		const result = invoke(root);
		expect(result.code).toBe(0);
		expect(result.stdout.indexOf("M first.txt")).toBeLessThan(result.stdout.indexOf("M second.txt"));
		expect(result.stdout).toContain("A owned/z.txt");
		expect(result.stdout).not.toContain("ignored.txt");

		const conflict = createRepository();
		conflict.manifest.deltas = [delta("tracked", ["tracked.txt"])];
		conflict.manifest.budget = { hybridPathCeiling: 1, hybridSourcePathCeiling: 0, droppedPathCeiling: 0, deltaUnitCeiling: 1, highRiskUnitCeiling: 0, privateUpstreamAssumptionCeiling: 0 };
		writeJson(join(conflict.root, "maintainers", "upstream.json"), conflict.manifest);
		git(conflict.root, "rm", "--cached", "tracked.txt");
		writeFileSync(join(conflict.root, "tracked.txt"), "replacement\n");
		const conflictResult = invoke(conflict.root, ["--check"]);
		expect(conflictResult.code).toBe(1);
		expect(conflictResult.stderr).toContain("both the baseline-worktree diff and git ls-files --others");
	});

	test("verifies tags, trees, packages and dependencies, including missing-tag fallback and drift", () => {
		const normal = createRepository();
		expect(invoke(normal.root, ["--check"])).toMatchObject({ code: 0 });
		git(normal.root, "tag", "-d", "v1.2.3");
		const fallback = invoke(normal.root, ["--check"]);
		expect(fallback.code).toBe(0);
		expect(fallback.stderr).toContain("tag v1.2.3 is unavailable locally");

		const drift = createRepository();
		const packageJson = JSON.parse(readFileSync(join(drift.root, "package.json"), "utf8"));
		packageJson.dependencies["@earendil-works/pi-ai"] = "9.9.9";
		writeJson(join(drift.root, "package.json"), packageJson);
		const shrinkwrap = JSON.parse(readFileSync(join(drift.root, "npm-shrinkwrap.json"), "utf8"));
		shrinkwrap.packages[""].dependencies["@earendil-works/pi-ai"] = "9.9.9";
		shrinkwrap.packages["node_modules/@earendil-works/pi-ai"].version = "9.9.9";
		writeJson(join(drift.root, "npm-shrinkwrap.json"), shrinkwrap);
		const driftResult = invoke(drift.root, ["--check"]);
		expect(driftResult.code).toBe(1);
		expect(driftResult.stderr).toContain("package.json.dependencies.@earendil-works/pi-ai");
		expect(driftResult.stderr).toContain("npm-shrinkwrap.json.packages");

		const baselineMismatch = createRepository();
		baselineMismatch.manifest.baseline.commit = "c".repeat(40);
		writeFileSync(join(baselineMismatch.root, "tree-mismatch.txt"), "mismatch\n");
		git(baselineMismatch.root, "add", "tree-mismatch.txt");
		git(baselineMismatch.root, "commit", "-m", "different source tree");
		baselineMismatch.manifest.baseline.sourceTree = git(baselineMismatch.root, "rev-parse", "HEAD^{tree}");
		baselineMismatch.manifest.baseline.codingAgentVersion = "9.9.9";
		writeJson(join(baselineMismatch.root, "maintainers", "upstream.json"), baselineMismatch.manifest);
		const baselineMismatchResult = invoke(baselineMismatch.root, ["--check"]);
		expect(baselineMismatchResult.stderr).toContain("does not match tag");
		expect(baselineMismatchResult.stderr).toContain("does not match v1.2.3:packages/coding-agent");
		expect(baselineMismatchResult.stderr).toContain("baseline.codingAgentVersion 9.9.9 does not match");

		const incompatible = createRepository({ sourceDependencies: { ...runtimeDependencies, "@earendil-works/pi-ai": "^2.0.0" } });
		const incompatibleResult = invoke(incompatible.root, ["--check"]);
		expect(incompatibleResult.code).toBe(1);
		expect(incompatibleResult.stderr).toContain("does not satisfy upstream coding-agent range");
	});

	test("allows a missing cache, updates and validates the derived cache, and never mutates it after invalid input", () => {
		const { root } = createRepository();
		expect(invoke(root, ["--check"]).code).toBe(0);
		expect(git(root, "branch", "--list", "upstream-extract")).toBe("");
		const created = invoke(root, ["--update-baseline"]);
		expect(created.code).toBe(0);
		expect(created.stdout).toContain("now points");
		writeFileSync(join(root, "cache-drift.txt"), "drift\n");
		git(root, "add", "cache-drift.txt");
		git(root, "commit", "-m", "different cache tree");
		git(root, "branch", "-f", "upstream-extract", "HEAD");
		expect(invoke(root, ["--check"]).stderr).toContain("baseline cache upstream-extract does not match");
		expect(invoke(root, ["--update-baseline"]).code).toBe(0);
		const idempotent = invoke(root, ["--update-baseline"]);
		expect(idempotent.stdout).toContain("already matches canonical");
		const branchBeforeInvalidManifest = git(root, "rev-parse", "upstream-extract");
		writeJson(join(root, "maintainers", "upstream.json"), {});
		expect(invoke(root, ["--update-baseline"]).code).toBe(1);
		expect(git(root, "rev-parse", "upstream-extract")).toBe(branchBeforeInvalidManifest);
		const invalidBaseline = createRepository();
		invoke(invalidBaseline.root, ["--update-baseline"]);
		const branchBeforeInvalidBaseline = git(invalidBaseline.root, "rev-parse", "upstream-extract");
		invalidBaseline.manifest.baseline.sourceTree = invalidBaseline.manifest.baseline.commit;
		writeJson(join(invalidBaseline.root, "maintainers", "upstream.json"), invalidBaseline.manifest);
		expect(invoke(invalidBaseline.root, ["--update-baseline"]).code).toBe(1);
		expect(git(invalidBaseline.root, "rev-parse", "upstream-extract")).toBe(branchBeforeInvalidBaseline);
	});
});
