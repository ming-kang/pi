import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { activityTarget } from "../src/extensions/agent/activity.ts";
import { agentRenderers } from "../src/extensions/agent/render.ts";
import type { AgentActivity, AgentToolDetails } from "../src/extensions/agent/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

interface RenderState {
	dispose?: () => void;
}
type RenderContext = ToolRenderContext<RenderState, unknown, AgentToolDetails>;

function context(result?: AgentToolResult<AgentToolDetails>, overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args: { description: "Inspect boundaries", prompt: "PRIVATE PROMPT" },
		result,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: result?.isError ?? false,
		durationMs: overrides.isPartial ? undefined : 6520,
		outputPad: 1,
		...overrides,
	};
}

function render(
	result: AgentToolResult<AgentToolDetails>,
	overrides: Partial<RenderContext> = {},
	width = 100,
): string {
	const ctx = context(result, overrides);
	const call = agentRenderers.renderCall(ctx.args, theme, ctx);
	const body = agentRenderers.renderResult(result, ctx, theme, ctx);
	return stripVTControlCharacters([...call.render(width), ...body.render(width)].join("\n")).trim();
}

const activities: AgentActivity[] = Array.from({ length: 7 }, (_, index) => ({
	id: `call/${index}`,
	name: "read",
	args: `{"path":"src/${index}.ts"}`,
	target: `src/${index}.ts`,
	status: index === 6 ? "running" : "ok",
	durationMs: index === 6 ? undefined : index + 1,
}));

function result(
	status: AgentToolDetails["status"],
	text = "progress",
	error?: string,
): AgentToolResult<AgentToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { version: 1, taskId: "agent-test", status, model: "test/model", thinking: "high", activities, error },
		isError: status === "failed" || status === "cancelled",
	};
}

const longBriefing =
	"Inspect offline fixture. Trace how Tasks persistence and completion delivery cooperate across session reload, cancellation, foreground handoff, branch restoration, and retained reports. Return relevant paths and verification.";

const call = (ctx: RenderContext) => agentRenderers.renderCall(ctx.args, theme, ctx);

describe("Agent transcript renderer", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps running collapsed to the latest activity and expands only the last five", () => {
		const running = result("running");
		expect(render(running, { isPartial: true })).toBe("Agent Inspect boundaries · read src/6.ts");
		const expanded = render(running, { isPartial: true, expanded: true });
		expect(expanded).toContain("Agent Inspect boundaries");
		expect(expanded).toContain("src/2.ts");
		expect(expanded).toContain("src/6.ts");
		expect(expanded).not.toContain("src/1.ts");
		expect(expanded.split("\n")).toHaveLength(6);
	});

	it("uses concise shell commands and preserves the PowerShell tool name", () => {
		const running = result("running");
		running.details.activities = [
			{
				id: "bash",
				name: "bash",
				args: '{"command":"npm run check\\nnpm test"}',
				target: activityTarget("bash", { command: "npm run check\nnpm test" }),
				status: "ok",
				durationMs: 100,
			},
			{
				id: "powershell",
				name: "powershell",
				args: '{"command":"Get-ChildItem src"}',
				target: activityTarget("powershell", { command: "Get-ChildItem src" }),
				status: "running",
			},
		];
		expect(render(running, { isPartial: true })).toBe("Agent Inspect boundaries · powershell Get-ChildItem src");
		const expanded = render(running, { isPartial: true, expanded: true });
		expect(expanded).toContain("bash npm run check · 100ms");
		expect(expanded).toContain("powershell Get-ChildItem src");
	});

	it("keeps background handoff to one status line", () => {
		expect(render(result("background", "long handoff guidance"))).toBe(
			"Agent Inspect boundaries · Background · /tasks",
		);
	});

	it("keeps cancellation and failure diagnostics to the same single-line treatment", () => {
		expect(render(result("cancelled", "Agent cancelled.", "Agent cancelled."))).toBe(
			"Agent Inspect boundaries · Cancelled · 6.5s · /tasks",
		);
		expect(render(result("failed", "Error: Model unavailable", "Model unavailable"), { expanded: true })).toBe(
			"Agent Inspect boundaries · Model unavailable · 6.5s · /tasks",
		);
	});

	it("renders exactly the same single status line for settled collapsed and expanded views", () => {
		const completed = result("completed", "## Report\n\nfirst\n\nsecond\n\nthird\n\nfourth");
		const collapsed = render(completed);
		expect(collapsed).toBe("Agent Inspect boundaries · 6.5s · /tasks");
		expect(render(completed, { expanded: true })).toBe(collapsed);
	});

	it("preserves duration and Tasks access for long default briefing labels", () => {
		const completed = result("completed", "Report.");
		const ctx = context(completed, { args: { prompt: longBriefing }, expanded: true });
		for (const width of [100, 60]) {
			const lines = call(ctx).render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
			expect(stripVTControlCharacters(lines[0]!)).toContain("/tasks");
			expect(stripVTControlCharacters(lines[0]!)).toContain("6.5s");
			expect(agentRenderers.renderResult(completed, ctx, theme, ctx).render(width)).toEqual([]);
		}
	});

	it("keeps long failure diagnostics width-safe and preserves Tasks access where it fits", () => {
		const error =
			"Resource temporarily unavailable: failed to connect to socket /tmp/worker.sock after 5 attempts over 30000ms";
		const ctx = context(result("failed", `Error: ${error}`, error), { args: { prompt: longBriefing } });
		for (const width of [0, 1, 5, 10, 20, 40, 60, 100]) {
			const lines = call(ctx).render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = stripVTControlCharacters(lines.join("\n"));
			if (width >= 40) {
				expect(text).toContain("Resource");
				expect(text).toContain("/tasks");
				expect(text).toContain("6.5s");
			}
		}
	});

	it("reuses lastComponent and respects CJK and emoji widths", () => {
		const ctx = context(result("completed"), {
			args: { prompt: "🔍 审查边界条件与后台任务生命周期，确保宽度计算正确" },
		});
		const first = call(ctx);
		ctx.lastComponent = first;
		expect(call(ctx)).toBe(first);
		for (const width of [60, 45, 30]) {
			const lines = first.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
		}
	});

	describe("clock lifecycle", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});

		it("stops periodic row invalidation after a foreground Agent hands off", () => {
			const invalidate = vi.fn();
			const ctx = context(result("running"), { executionStarted: true, isPartial: true, invalidate });
			call(ctx).render(100);
			vi.advanceTimersByTime(1000);
			expect(invalidate).toHaveBeenCalled();
			const settled: RenderContext = { ...ctx, result: result("background"), isPartial: false, durationMs: 1000 };
			expect(stripVTControlCharacters(call(settled).render(100).join("\n"))).toBe(
				"Agent Inspect boundaries · Background · /tasks",
			);
			invalidate.mockClear();
			vi.advanceTimersByTime(3000);
			expect(invalidate).not.toHaveBeenCalled();
		});

		it("does not arm a clock before execution or for an immediate background handoff", () => {
			const invalidate = vi.fn();
			call(context(undefined, { isPartial: true, invalidate })).render(100);
			call(context(result("background"), { executionStarted: true, invalidate })).render(100);
			vi.advanceTimersByTime(3000);
			expect(invalidate).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("disposes live timing once, preserves other cleanup and cannot rearm after disposal", () => {
			const invalidate = vi.fn();
			const previousDispose = vi.fn();
			const state: RenderState = { dispose: previousDispose };
			const ctx = context(result("running"), { state, executionStarted: true, isPartial: true, invalidate });
			call(ctx).render(100);
			vi.advanceTimersByTime(1000);
			expect(invalidate).toHaveBeenCalled();
			state.dispose?.();
			state.dispose?.();
			expect(previousDispose).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			invalidate.mockClear();
			call(ctx).render(100);
			vi.advanceTimersByTime(3000);
			expect(invalidate).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
