import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
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

function createDetachHintRenderer(
	toolName: string,
	options: { detachable?: boolean; keyLabel?: string } = {},
): ToolExecutionComponent {
	const tool =
		toolName === "bash"
			? createBashToolDefinition(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } })
			: undefined;
	return new ToolExecutionComponent(
		toolName,
		`${toolName}-detach-hint-test`,
		toolName === "bash" ? { command: "sleep 60" } : { tasks: [] },
		{
			detachHint: {
				isDetachable: (name: string) => options.detachable ?? name === toolName,
				keyLabel: () => options.keyLabel ?? "Ctrl+B",
			},
		},
		tool,
		{ requestRender: () => {} } as never,
		process.cwd(),
	);
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
		expect(renderCall(component, 120)).not.toContain("run in background");

		vi.setSystemTime(59_950);
		component.invalidate();
		expect(renderCall(component, 120)).toContain("Running… (1m 0s)");
		vi.setSystemTime(119_500);
		component.invalidate();
		const roundedMinutes = renderCall(component, 120);
		expect(roundedMinutes).toContain("Running… (2m 0s)");
		expect(roundedMinutes).not.toContain("1m 60s");

		component.updateResult({ content: [{ type: "text", text: "(no output)" }], isError: false }, false);
		const completed = renderCall(component, 120);
		expect(completed).toContain("(no output)");
		expect(completed).not.toContain("run in background");
		expect(completed).not.toContain("Running");
		expect(completed).not.toContain("Took");
	});

	test.each([createBashToolDefinition, createPowerShellToolDefinition])(
		"renders handoff as settled native output without a stale timer (%#)",
		(factory) => {
			vi.useFakeTimers();
			const tool = factory(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
			const component = new ToolExecutionComponent(
				tool.name,
				"handoff",
				{ command: "work", background: true },
				{},
				tool,
				{ requestRender: () => {} } as never,
				process.cwd(),
			);
			component.setArgsComplete();
			component.markExecutionStarted();
			component.updateResult({ content: [], isError: false }, true);
			vi.advanceTimersByTime(3000);
			if (tool.name === "bash") expect(renderCall(component, 120)).toContain("Running");
			component.updateResult(
				{
					content: [{ type: "text", text: "Command running in background" }],
					details: { background: { kind: "background", taskId: "bash-task" }, fullOutputPath: "output.log" },
					isError: false,
				},
				false,
			);
			vi.advanceTimersByTime(5000);
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const rendered = renderCall(component, 120);
				expect(rendered).toContain("Moved to background · bash-task");
				expect(rendered).toContain("Full output: output.log");
				expect(rendered).not.toContain("Running");
				expect(rendered).not.toContain("exit code");
			}
		},
	);

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

describe("detach hint on long-running foreground cards", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("appears after the delay with the resolved key label and clears on settlement", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = createDetachHintRenderer("bash");
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);

		vi.setSystemTime(9_999);
		component.invalidate();
		expect(renderCall(component, 120)).not.toContain("run in background");

		vi.setSystemTime(10_000);
		component.invalidate();
		expect(renderCall(component, 120)).toContain("Press Ctrl+B to run in background, /bg to manage");

		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		expect(renderCall(component, 120)).not.toContain("run in background");
	});

	test("hides when the key is unbound or the tool is not detachable", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const unbound = createDetachHintRenderer("bash", { keyLabel: "" });
		unbound.markExecutionStarted();
		unbound.updateResult({ content: [], isError: false }, true);
		vi.setSystemTime(15_000);
		unbound.invalidate();
		expect(renderCall(unbound, 120)).not.toContain("run in background");

		const fixed = createDetachHintRenderer("bash", { detachable: false });
		fixed.markExecutionStarted();
		fixed.updateResult({ content: [], isError: false }, true);
		vi.setSystemTime(15_000);
		fixed.invalidate();
		expect(renderCall(fixed, 120)).not.toContain("run in background");
	});

	test("shows on subagent cards without the generic running line", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = createDetachHintRenderer("subagent");
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);

		vi.setSystemTime(5_000);
		component.invalidate();
		expect(renderCall(component, 120)).not.toContain("Running…");

		vi.setSystemTime(11_000);
		component.invalidate();
		const frame = renderCall(component, 120);
		expect(frame).not.toContain("Running…");
		expect(frame).toContain("Press Ctrl+B to run in background, /bg to manage");
	});
});
