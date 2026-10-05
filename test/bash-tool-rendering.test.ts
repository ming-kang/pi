import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/tool-view/tool-execution.ts";
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

	test("keeps long commands as a raw preview with timeout metadata", () => {
		const component = createRenderer(
			"pwd && git branch --show-current && git status --short && git log -1 --oneline && git tag --points-at HEAD && git remote -v && npm --version && node --version",
			120,
		);
		component.setArgsComplete();

		const rendered = renderCall(component, 100);
		expect(rendered).toContain("● $ pwd && git branch --show-current");
		expect(rendered).toContain("(timeout 120s)");
	});

	test("shows the complete raw command when expanded", () => {
		const command =
			"cd ../Pi && git add -- README.md docs/README.md && git commit -m 'release docs' && git push origin main";
		const component = createRenderer(command);
		component.setArgsComplete();
		component.setExpanded(true);

		expect(renderCall(component, 300)).toContain(command);
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

	test("shows Elapsed while running and a fixed Took once settled, without a shell progress row", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = createRenderer("npm run check");
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);

		vi.advanceTimersByTime(4000);
		const running = renderCall(component, 120);
		expect(running).toContain("Elapsed 4.0s");
		expect(running).not.toContain("Running");
		expect(running).not.toContain("background");

		component.updateResult({ content: [{ type: "text", text: "(no output)" }], isError: false }, false);
		const settled = renderCall(component, 120);
		expect(settled).toContain("(no output)");
		expect(settled).toContain("Took 4.0s");
		expect(settled).not.toContain("Elapsed");

		vi.advanceTimersByTime(60_000);
		component.invalidate();
		expect(renderCall(component, 120)).toBe(settled);
	});

	test("stops the Elapsed refresh when the row is disposed while running", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
		const component = new ToolExecutionComponent(
			"bash",
			"bash-dispose",
			{ command: "sleep 60" },
			{},
			tool,
			{ requestRender } as never,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);
		vi.advanceTimersByTime(2000);
		component.dispose();
		const requests = requestRender.mock.calls.length;
		vi.advanceTimersByTime(5000);
		expect(requestRender).toHaveBeenCalledTimes(requests);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([createBashToolDefinition, createPowerShellToolDefinition])(
		"keeps inherited result timing with a custom call renderer (%#)",
		(factory) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const tool = factory(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
			const requestRender = vi.fn();
			const definition: typeof tool = { ...tool, renderCall: () => new Text("Custom shell header", 0, 0) };
			const component = new ToolExecutionComponent(
				tool.name,
				"custom-header",
				{ command: "sleep 30" },
				{},
				definition,
				{ requestRender } as never,
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult({ content: [], isError: false }, true);
			requestRender.mockClear();
			vi.advanceTimersByTime(3000);
			expect(requestRender).toHaveBeenCalledTimes(3);
			component.setExpanded(true);
			component.invalidate();
			expect(renderCall(component, 80)).toContain("Elapsed 3.0s");
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			expect(renderCall(component, 80)).toContain("Took 3.0s");
			vi.advanceTimersByTime(5000);
			component.invalidate();
			expect(renderCall(component, 80)).toContain("Took 3.0s");
			expect(vi.getTimerCount()).toBe(0);
			component.dispose();
		},
	);

	test.each([false, true])("cleans up shell timing alongside an extension disposer (throws=%s)", (throws) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
		const cleanup = vi.fn(() => {
			if (throws) throw new Error("extension cleanup failed");
		});
		const definition: typeof tool = {
			...tool,
			renderCall(args, theme, context) {
				context.state.dispose ??= cleanup;
				return tool.renderCall!(args, theme, context);
			},
		};
		const component = new ToolExecutionComponent(
			"bash",
			"composed-cleanup",
			{ command: "sleep 30" },
			{},
			definition,
			{ requestRender() {} } as never,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);
		vi.advanceTimersByTime(2000);
		component.invalidate();
		expect(renderCall(component, 80)).toContain("Elapsed 2.0s");
		if (throws) expect(() => component.dispose()).toThrow("extension cleanup failed");
		else component.dispose();
		component.dispose();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not invent timing for a replayed shell result", () => {
		vi.useFakeTimers();
		const component = createRenderer("echo done");
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		component.setExpanded(true);
		component.invalidate();
		expect(renderCall(component, 80)).not.toMatch(/Elapsed|Took/);
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each([
		[createBashToolDefinition, true],
		[createPowerShellToolDefinition, true],
		[createBashToolDefinition, false],
		[createPowerShellToolDefinition, false],
	] as const)("renders handoff as settled native output without a stale timer (%#)", (factory, submitted) => {
		vi.useFakeTimers();
		const tool = factory(process.cwd(), { operations: { exec: async () => ({ exitCode: 0 }) } });
		const component = new ToolExecutionComponent(
			tool.name,
			"handoff",
			{ command: "work", ...(submitted ? { background: true } : {}) },
			{},
			tool,
			{ requestRender: () => {} } as never,
			process.cwd(),
		);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);
		vi.advanceTimersByTime(3000);
		expect(renderCall(component, 120)).toContain("Elapsed 3.0s");
		component.updateResult(
			{
				content: [{ type: "text", text: "Command running in background" }],
				details: { background: { kind: "background", taskId: "bash-task" }, fullOutputPath: "output.log" },
				isError: false,
			},
			false,
		);
		vi.advanceTimersByTime(5000);
		// Work submitted as background is running from the start; work the user moved mid-run
		// was already running, and the row has to say which one it was.
		const label = submitted ? "Running in the background · bash-task" : "Moved to background · bash-task";
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			const rendered = renderCall(component, 120);
			expect(rendered).toContain(label);
			expect(rendered).toContain("Full output: output.log");
			expect(rendered).toContain("Took 3.0s");
			expect(rendered).not.toContain("Elapsed");
			expect(rendered).not.toContain("exit code");
		}
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
