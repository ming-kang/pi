import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "../src/core/tasks/types.ts";
import { exploreTaskView } from "../src/extensions/explore/view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("Explore task view", () => {
	it("separates immutable investigation information from Markdown report structure", () => {
		initTheme("dark");
		const task: TaskSnapshot = {
			id: "explore-test",
			kind: "explore",
			title: "Find settings",
			toolCallId: "call",
			anchorId: null,
			mode: "background",
			status: "running",
			startedAt: 1,
			viewData: {
				version: 1,
				data: {
					query: "Find settings",
					path: "src",
					model: "test/model",
					thinking: "high",
					activities: ["read src/settings.ts"],
					report: "# Information\n\n## Answer\nA report with **evidence**.\n```ts\nconst value = 42;\n```",
				},
			},
		};
		const view = exploreTaskView.create({ theme, requestRender() {} });
		view.update(task);
		const info = view.info.render(50).map(stripTerminalSequences).join("\n");
		const output = view.output.render(50).map(stripTerminalSequences).join("\n");
		expect(info).toContain("test/model");
		expect(info).not.toContain("const value");
		expect(output).toContain("const value = 42");
		for (const line of [...view.info.render(24), ...view.output.render(24)])
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		task.status = "completed";
		view.update(task);
		expect(view.output.render(50).map(stripTerminalSequences).join("\n")).not.toContain("read src/settings.ts");
	});
	it("reads saved result text when display metadata is absent", () => {
		initTheme("dark");
		const view = exploreTaskView.create({ theme, requestRender() {} });
		view.update({
			id: "explore-old",
			kind: "explore",
			title: "Question",
			toolCallId: "call",
			anchorId: null,
			mode: "background",
			status: "completed",
			startedAt: 1,
			result: { content: [{ type: "text", text: "Saved evidence" }], details: undefined },
		});
		expect(view.output.render(50).map(stripTerminalSequences).join("\n")).toContain("Saved evidence");
	});
});
