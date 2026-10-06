import { describe, expect, test } from "vitest";
import { classifyLockfileChanges } from "../scripts/check-lockfile-commit.mjs";
import { nextVersion, stampChangelog } from "../scripts/release.mjs";

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
