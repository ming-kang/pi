import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createRenderer(command: unknown, timeout?: number): ToolExecutionComponent {
	const operations: BashOperations = {
		exec: async () => ({ exitCode: 0 }),
	};
	const tool = createBashToolDefinition(process.cwd(), { operations });
	return new ToolExecutionComponent(
		"bash",
		"bash-render-test",
		{ command, ...(timeout === undefined ? {} : { timeout }) },
		{},
		tool,
		{ requestRender: () => {} } as never,
		process.cwd(),
	);
}

function renderCall(component: ToolExecutionComponent, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("bash tool call rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps short commands as a complete one-line call", () => {
		const component = createRenderer("git status --short");
		component.setArgsComplete();

		expect(renderCall(component, 120)).toContain("● $ git status --short");
	});

	test("keeps long multi-command calls as a faithful raw preview", () => {
		const command =
			"cd ../Pi && git add -- README.md docs/README.md docs/architecture.md && git diff --cached --check && git commit -m 'docs: release process' && git push origin main";
		const component = createRenderer(command);
		component.setArgsComplete();

		const rendered = renderCall(component, 80);
		expect(rendered).toContain("● $ cd ../Pi && git add -- README.md");
		expect(rendered).not.toContain("cd, git …");
	});

	test("preserves raw command chains and timeout metadata", () => {
		const component = createRenderer(
			"pwd && git branch --show-current && git status --short && git log -1 --oneline && git tag --points-at HEAD && git remote -v && npm --version && node --version",
			120,
		);
		component.setArgsComplete();

		const rendered = renderCall(component, 100);
		expect(rendered).toContain("● $ pwd && git branch --show-current");
		expect(rendered).toContain("(timeout 120s)");
		expect(rendered).not.toContain("pwd, git");
	});

	test("keeps complex long commands as a truncated raw preview", () => {
		const component = createRenderer(
			"node scripts/release.js --channel nightly --repository ming-kang/pi --version 0.81.1-2 && git status --short && echo $(git rev-parse HEAD)",
		);
		component.setArgsComplete();

		const rendered = renderCall(component, 80);
		expect(rendered).toContain("● $ node scripts/release.js");
		expect(rendered).not.toContain("node, git");
	});

	test("does not summarize while arguments are still streaming", () => {
		const component = createRenderer("find . -name '*.ts' && gh run list && git status");

		const rendered = renderCall(component, 50);
		expect(rendered).not.toContain("find, gh, git");
	});

	test("shows the complete raw command when expanded", () => {
		const command =
			"cd ../Pi && git add -- README.md docs/README.md && git commit -m 'release docs' && git push origin main";
		const component = createRenderer(command);
		component.setArgsComplete();
		component.setExpanded(true);

		const rendered = renderCall(component, 300);
		expect(rendered).toContain(command);
		expect(rendered).not.toContain("cd, git …");
	});

	test("keeps timeout metadata visible in raw previews", () => {
		const component = createRenderer(
			"find packages/coding-agent/src -type f -name '*.ts' && gh run list --workflow publish-npm.yml --limit 20 && git status --short",
			180,
		);
		component.setArgsComplete();

		const rendered = renderCall(component, 100);
		expect(rendered).toContain("$ find packages/coding-agent/src");
		expect(rendered).toContain("(timeout 180s)");
	});

	test("recomputes the raw call layout when the terminal width changes", () => {
		const command =
			"find packages/coding-agent/src -type f && gh run list --workflow publish-npm.yml && git status --short";
		const component = createRenderer(command);
		component.setArgsComplete();

		expect(renderCall(component, 300)).toContain(command);
		expect(renderCall(component, 60)).toContain("$ find packages/coding-agent/src");
	});

	test("never renders lines wider than the available terminal width", () => {
		const component = createRenderer(
			"find packages/coding-agent/src -type f && gh run list --workflow publish-npm.yml && git status --short",
			180,
		);
		component.setArgsComplete();

		for (const width of [30, 60, 100, 160]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("delays running duration until the two-second threshold", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = createRenderer("npm run check");
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);

		expect(renderCall(component, 120)).not.toContain("Running");
		vi.advanceTimersByTime(1999);
		expect(renderCall(component, 120)).not.toContain("Running");
		vi.advanceTimersByTime(1);
		expect(renderCall(component, 120)).toContain("Running… (2.0s)");

		component.updateResult({ content: [{ type: "text", text: "(no output)" }], isError: false }, false);
		const completed = renderCall(component, 120);
		expect(completed).toContain("(no output)");
		expect(completed).not.toContain("Running");
		expect(completed).not.toContain("Took");
	});

	test("preserves empty and invalid argument fallbacks", () => {
		const empty = createRenderer("");
		empty.setArgsComplete();
		expect(renderCall(empty, 80)).toContain("$ ...");

		const invalid = createRenderer(42);
		invalid.setArgsComplete();
		expect(renderCall(invalid, 80)).toContain("$ [invalid arg]");
	});

	afterEach(() => {
		vi.useRealTimers();
	});
});
