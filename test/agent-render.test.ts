import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { agentRenderers } from "../src/extensions/agent/render.ts";
import type { AgentActivity, AgentToolDetails } from "../src/extensions/agent/types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function render(result: AgentToolResult<AgentToolDetails>, { expanded = false, isPartial = false } = {}): string {
	const context = {
		args: { prompt: "PRIVATE PROMPT" },
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
		isError: false,
		durationMs: undefined,
		outputPad: 1,
	} satisfies ToolRenderContext;
	const component = agentRenderers.renderResult?.(result, { expanded, isPartial }, theme, context) as Component;
	return stripVTControlCharacters(component.render(100).join("\n")).trim();
}

const activities: AgentActivity[] = Array.from({ length: 5 }, (_, index) => ({
	id: `call/${index}`,
	name: "read",
	args: `{"path":"src/${index}.ts"}`,
	status: index === 4 ? "running" : "ok",
	durationMs: index === 4 ? undefined : index + 1,
}));

function details(status: AgentToolDetails["status"]): AgentToolDetails {
	return { version: 1, taskId: "agent-test", status, model: "test/model", thinking: "high", activities };
}

describe("Agent transcript renderer", () => {
	beforeAll(() => initTheme("dark"));

	it("shows only recent real activity while running, and more of the same when expanded", () => {
		const result = { content: [{ type: "text" as const, text: "progress" }], details: details("running") };
		const collapsed = render(result, { isPartial: true });
		expect(collapsed).toContain("2 earlier activities");
		expect(collapsed).toContain("src/2.ts");
		expect(collapsed).toContain('… read {"path":"src/4.ts"}');
		expect(collapsed).not.toContain("PRIVATE PROMPT");
		expect(collapsed).not.toContain("test/model");
		const expanded = render(result, { isPartial: true, expanded: true });
		expect(expanded).toContain("src/0.ts");
		expect(expanded).toContain("src/4.ts");
		expect(expanded).not.toContain("PRIVATE PROMPT");
	});

	it("keeps a handed-off call compact and points to Tasks", () => {
		const text = render({
			content: [{ type: "text", text: "long handoff guidance" }],
			details: details("background"),
		});
		expect(text).toContain("Running in background · /tasks to inspect");
		expect(text).not.toContain("long handoff guidance");
	});

	it("previews a finished report collapsed and expands only the full report", () => {
		const result = {
			content: [{ type: "text" as const, text: "## Report\n\nfirst\n\nsecond\n\nthird\n\nfourth" }],
			details: details("completed"),
		};
		const collapsed = render(result);
		expect(collapsed).toContain("more report lines");
		expect(collapsed).not.toContain("fourth");
		expect(collapsed).not.toContain("read");
		const expanded = render(result, { expanded: true });
		expect(expanded).toContain("Report");
		expect(expanded).toContain("fourth");
		expect(expanded).not.toContain("PRIVATE PROMPT");
		expect(expanded).not.toContain("test/model");
	});
});
