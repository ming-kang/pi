import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

const ui = new TuiMainScreen(new VirtualTerminal(80, 24));

type OutputPaddedComponent = Component & { setOutputPad(outputPad: number): void };

/** Text lines without ANSI codes or trailing fill. Blank lines and full-width borders are skipped. */
function renderLines(component: Component): string[] {
	return component
		.render(60)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => /[\w$(]/.test(line));
}

const components: Array<{ name: string; create: (outputPad: number) => OutputPaddedComponent }> = [
	{
		name: "bash execution",
		create: (outputPad) => {
			const component = new BashExecutionComponent("pwd", ui, false, outputPad);
			component.appendOutput("/tmp");
			component.setComplete(1, false);
			return component;
		},
	},
	{
		name: "compaction summary",
		create: (outputPad) =>
			new CompactionSummaryMessageComponent(
				{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 },
				undefined,
				outputPad,
			),
	},
];

describe("outputPad", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		ui.stop();
	});

	test.each(components)("$name renders at outputPad 0 and 1", ({ create }) => {
		const component = create(0);
		const lines = renderLines(component);
		expect(lines.filter((line) => line.startsWith(" "))).toEqual([]);
		component.setOutputPad(1);
		expect(renderLines(component)).toEqual(lines.map((line) => ` ${line}`));
	});
});
