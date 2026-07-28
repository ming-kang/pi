import { describe, expect, test } from "vitest";
import { staleTermFailures } from "../scripts/check-docs-core.mjs";

describe("documentation stale-term checks", () => {
	test("finds standalone-invalid monorepo paths in prose and code fences", () => {
		expect(staleTermFailures("docs/example.md", "Use packages/coding-agent here.")).toEqual([
			"docs/example.md: contains a standalone-invalid packages/coding-agent path",
		]);
		expect(staleTermFailures("examples/config.md", "```json\n{ \"source\": \"packages/ai\" }\n```")).toEqual([
			"examples/config.md: contains a standalone-invalid packages/ai path",
		]);
		expect(staleTermFailures("docs/ecosystem.md", "The packages/airlock example is standalone.")).toEqual([]);
	});

	test("ignores external URLs while retaining visible Markdown link labels", () => {
		expect(
			staleTermFailures(
				"docs/links.md",
				"[packages/tui](https://example.test/packages/coding-agent) https://example.test/packages/ai",
			),
		).toEqual(["docs/links.md: contains a standalone-invalid packages/tui path"]);
		expect(
			staleTermFailures("docs/links.md", "https://example.test/packages/coding-agent"),
		).toEqual([]);
	});

	test("finds every controlled stale category", () => {
		const failures = staleTermFailures(
			"examples/stale.ts",
			[
				"packages/agent-core",
				"@mariozechner/pi-ai",
				"badlogic/pi-mono",
				"pnpm-workspace.yaml",
				"upstream-extract",
			].join("\n"),
		);
		expect(failures).toEqual([
			"examples/stale.ts: contains a standalone-invalid packages/agent-core path",
			"examples/stale.ts: contains a legacy package identifier: @mariozechner/pi-ai",
			"examples/stale.ts: contains a legacy monorepo repository identifier: badlogic/pi-mono",
			"examples/stale.ts: contains workspace-only metadata: pnpm-workspace.yaml",
			"examples/stale.ts: contains maintainer-only leakage: upstream-extract",
		]);
	});

	test("finds workspace protocols but allows ordinary workspace prose", () => {
		expect(staleTermFailures("examples/config.json", '"dependency": "workspace:^1.2.3"')).toEqual([
			"examples/config.json: contains workspace-only metadata: workspace:^",
		]);
		expect(staleTermFailures("examples/gondolin.ts", "Host workspace: /tmp/project")).toEqual([]);
	});

	test("allows only the exact historical CHANGELOG maintainers reference", () => {
		const historicalReference =
			"Repository architecture, upstream synchronization, development, and release procedures now live separately under `maintainers/` and are excluded from npm packages.";
		expect(staleTermFailures("CHANGELOG.md", historicalReference)).toEqual([]);
		expect(staleTermFailures("CHANGELOG.md", `${historicalReference}\nRead maintainers/ for details.`)).toEqual([
			"CHANGELOG.md: contains maintainer-only leakage: maintainers/",
		]);
		expect(staleTermFailures("CHANGELOG.md", "Moved to `maintainers/`.")).toEqual([
			"CHANGELOG.md: contains maintainer-only leakage: maintainers/",
		]);
		expect(staleTermFailures("CHANGELOG.md", "Read maintainers/upstream.json.")).toEqual([
			"CHANGELOG.md: contains maintainer-only leakage: maintainers/upstream.json",
		]);
		expect(staleTermFailures("README.md", "Read maintainers/ for release details.")).toEqual([
			"README.md: contains maintainer-only leakage: maintainers/",
		]);
	});

	test("scans release history below Unreleased", () => {
		const changelog = "## [Unreleased]\n\nNothing yet.\n\n## [0.1.0]\n\nMigrated from mariozechner/pi-mono.";
		expect(staleTermFailures("CHANGELOG.md", changelog)).toEqual([
			"CHANGELOG.md: contains a legacy monorepo repository identifier: mariozechner/pi-mono",
		]);
	});

	test("emits no duplicate category messages for a file", () => {
		const failures = staleTermFailures(
			"docs/repeated.md",
			"packages/coding-agent packages/ai packages/coding-agent @mariozechner/pi-tui pi-coding-agent",
		);
		expect(failures).toEqual([
			"docs/repeated.md: contains a standalone-invalid packages/coding-agent path",
			"docs/repeated.md: contains a legacy package identifier: @mariozechner/pi-tui",
		]);
	});
});
