import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { activityTarget } from "../src/extensions/agent/activity.ts";
import { agentRenderers } from "../src/extensions/agent/render.ts";
import type { AgentActivity, AgentToolDetails } from "../src/extensions/agent/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function render(result: AgentToolResult<AgentToolDetails>, { expanded = false, isPartial = false } = {}): string {
	const context = {
		args: { description: "Inspect boundaries", prompt: "PRIVATE PROMPT" },
		result,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: false,
		argsComplete: true,
		isPartial,
		expanded,
		showImages: false,
		isError: result.isError ?? false,
		durationMs: isPartial ? undefined : 6520,
		outputPad: 1,
	} satisfies ToolRenderContext;
	const call = agentRenderers.renderCall?.(context.args, theme, context) as Component;
	const body = agentRenderers.renderResult?.(result, { expanded, isPartial }, theme, context) as Component;
	return stripVTControlCharacters([...call.render(100), ...body.render(100)].join("\n")).trim();
}

const activities: AgentActivity[] = Array.from({ length: 7 }, (_, index) => ({
	id: `call/${index}`,
	name: "read",
	args: `{"path":"src/${index}.ts"}`,
	target: `src/${index}.ts`,
	status: index === 6 ? "running" : "ok",
	durationMs: index === 6 ? undefined : index + 1,
}));

function details(status: AgentToolDetails["status"]): AgentToolDetails {
	return { version: 1, taskId: "agent-test", status, model: "test/model", thinking: "high", activities };
}

describe("Agent transcript renderer", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps running collapsed to the latest activity and expands only the last five", () => {
		const result = { content: [{ type: "text" as const, text: "progress" }], details: details("running") };
		const collapsed = render(result, { isPartial: true });
		expect(collapsed).toBe("Agent Inspect boundaries · read src/6.ts");
		const expanded = render(result, { isPartial: true, expanded: true });
		expect(expanded).toContain("Agent Inspect boundaries");
		expect(expanded).toContain("src/2.ts");
		expect(expanded).toContain("src/6.ts");
		expect(expanded).not.toContain("src/1.ts");
		expect(expanded.split("\n")).toHaveLength(6);
	});

	it("uses concise shell commands and preserves the PowerShell tool name", () => {
		const shellActivities: AgentActivity[] = [
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
		const result = {
			content: [{ type: "text" as const, text: "progress" }],
			details: { ...details("running"), activities: shellActivities },
		};
		expect(render(result, { isPartial: true })).toBe("Agent Inspect boundaries · powershell Get-ChildItem src");
		const expanded = render(result, { isPartial: true, expanded: true });
		expect(expanded).toContain("bash npm run check · 100ms");
		expect(expanded).toContain("powershell Get-ChildItem src");
	});

	it("keeps background handoff to one status line", () => {
		const text = render({
			content: [{ type: "text", text: "long handoff guidance" }],
			details: details("background"),
		});
		expect(text).toBe("Agent Inspect boundaries · Background · /tasks");
	});

	it("keeps cancellation and failure diagnostics to the same single-line treatment", () => {
		const cancelled = {
			content: [{ type: "text" as const, text: "Agent cancelled." }],
			details: { ...details("cancelled"), error: "Agent cancelled." },
			isError: true,
		};
		expect(render(cancelled)).toBe("Agent Inspect boundaries · Cancelled · 6.5s · /tasks");
		const failed = {
			content: [{ type: "text" as const, text: "Error: Model unavailable" }],
			details: { ...details("failed"), error: "Model unavailable" },
			isError: true,
		};
		expect(render(failed, { expanded: true })).toBe("Agent Inspect boundaries · Model unavailable · 6.5s · /tasks");
	});

	it("renders exactly the same single status line for settled collapsed and expanded views", () => {
		const result = {
			content: [{ type: "text" as const, text: "## Report\n\nfirst\n\nsecond\n\nthird\n\nfourth" }],
			details: details("completed"),
		};
		const collapsed = render(result);
		expect(collapsed).toBe("Agent Inspect boundaries · 6.5s · /tasks");
		expect(render(result, { expanded: true })).toBe(collapsed);
	});
});
