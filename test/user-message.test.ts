import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("renders compact full-width rows with OSC markers at line starts", () => {
		initTheme("dark");

		const single = new UserMessageComponent("hello").render(20);
		expect(single).toHaveLength(1);
		expect(single[0]!.startsWith(OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(stripAnsi(single[0]!)).toBe(` ❯ hello${" ".repeat(12)}`);
		expect(single[0]!.endsWith(BG_RESET)).toBe(true);

		const multi = new UserMessageComponent("first\n\nsecond").render(20);
		expect(multi.map((line) => stripAnsi(line).trimEnd())).toEqual([" ❯ first", "", "   second"]);
		expect(multi[0]!.startsWith(OSC133_ZONE_START)).toBe(true);
		expect(multi[0]).not.toContain(OSC133_ZONE_END);
		expect(multi[2]!.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		for (const line of multi) {
			expect(visibleWidth(line)).toBe(20);
			expect(line.endsWith(BG_RESET)).toBe(true);
		}
	});

	test("wraps long text under the first text column", () => {
		initTheme("dark");

		const lines = new UserMessageComponent("alpha beta gamma delta").render(15);
		expect(lines.map((line) => stripAnsi(line).trimEnd())).toEqual([" ❯ alpha beta", "   gamma delta"]);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 76 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
