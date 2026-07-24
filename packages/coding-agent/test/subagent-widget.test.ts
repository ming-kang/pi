import { describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { SubagentDetails, SubagentRunDetails } from "../src/extensions/subagent/types.ts";
import { SubagentWidget } from "../src/extensions/subagent/widget.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function run(overrides: Partial<SubagentRunDetails> = {}): SubagentRunDetails {
	return {
		id: "subagent-1",
		agent: "explorer",
		agentSource: "builtin",
		description: "Map the code",
		prompt: "Inspect the code.",
		cwd: "/project",
		model: "test/model",
		thinking: "low",
		status: "completed",
		activities: [],
		liveText: "",
		finalOutput: "Found the entry point.",
		usage: { turns: 1, toolUses: 2, input: 10, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: 0 },
		...overrides,
	};
}

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		mode: "parallel",
		status: "running",
		startedAt: 0,
		usage: { turns: 1, toolUses: 2, input: 10, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: 0 },
		runs: [run()],
		...overrides,
	};
}

type WidgetFactory = (tui: { requestRender: () => void }, theme: Theme) => { render: (width: number) => string[] };

function createUI() {
	const widgets = new Map<string, unknown>();
	const ui = {
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
	} as unknown as ExtensionUIContext;
	const render = (): string => {
		const factory = widgets.get("subagents") as WidgetFactory | undefined;
		if (!factory) return "";
		return factory({ requestRender: () => {} }, theme)
			.render(120)
			.join("\n");
	};
	return { ui, widgets, render };
}

describe("subagent widget panel", () => {
	it("aggregates concurrent calls and keeps active runs first", () => {
		const { ui, render } = createUI();
		const widget = new SubagentWidget();
		widget.update(ui, "call-1", details({ status: "completed", runs: [run({ agent: "a1", description: "one" })] }));
		widget.update(
			ui,
			"call-2",
			details({ runs: [run({ agent: "a2", description: "two", status: "running", currentActivity: "reading" })] }),
		);
		const output = render();
		expect(output).toContain("a1 · one");
		expect(output).toContain("a2 · two");
		expect(output).toContain("reading");
		expect(output.indexOf("a2")).toBeLessThan(output.indexOf("a1"));
		widget.dispose();
	});

	it("caps visible rows and reports the hidden remainder", () => {
		const { ui, render } = createUI();
		const widget = new SubagentWidget();
		const runs = Array.from({ length: 8 }, (_, index) => run({ id: `run-${index}`, agent: `agent-${index}` }));
		widget.update(ui, "call-1", details({ runs }));
		expect(render()).toContain("+2 more");
		widget.dispose();
	});

	it("shows moving elapsed time for running rows", () => {
		const { ui, render } = createUI();
		const widget = new SubagentWidget();
		widget.update(
			ui,
			"call-1",
			details({
				runs: [
					run({ status: "running", startedAt: Date.now() - 5_000, currentActivity: "scanning", finalOutput: "" }),
				],
			}),
		);
		expect(render()).toMatch(/· \d+(?:\.\d+)?s/u);
		widget.dispose();
	});

	it("clears the widget only after the last call finishes", () => {
		const { ui, widgets } = createUI();
		const widget = new SubagentWidget();
		widget.update(ui, "call-1", details());
		widget.update(ui, "call-2", details());
		widget.finish("call-1");
		expect(widgets.has("subagents")).toBe(true);
		widget.finish("call-2");
		expect(widgets.has("subagents")).toBe(false);
	});
});
