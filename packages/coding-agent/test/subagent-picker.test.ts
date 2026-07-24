import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type PickerItem, SearchPickerComponent } from "../src/extensions/subagent/picker.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function items(): PickerItem<string | null>[] {
	return [
		{ value: null, label: "inherit", detail: "Follow the parent session (deepseek/v4)", current: true },
		{ value: "a/one", label: "a/one" },
		{ value: "b/two", label: "b/two", detail: "Two" },
	];
}

describe("subagent search picker", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("renders the list with the current value marked and its detail shown", () => {
		const picker = new SearchPickerComponent(theme, "Model for explorer", items(), () => {});
		const output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Model for explorer");
		expect(output).toContain("→ inherit ✓");
		expect(output).toContain("a/one");
		expect(output).toContain("Follow the parent session (deepseek/v4)");
	});

	it("filters as the user types and confirms the top match on enter", () => {
		let selected: string | null | undefined;
		let called = false;
		const picker = new SearchPickerComponent(theme, "Model", items(), (value) => {
			called = true;
			selected = value;
		});
		for (const char of "two") picker.handleInput(char);
		const output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("b/two");
		expect(output).not.toContain("a/one");
		picker.handleInput("\r");
		expect(called).toBe(true);
		expect(selected).toBe("b/two");
	});

	it("wraps the selection when navigating past either end", () => {
		let selected: string | null | undefined;
		const picker = new SearchPickerComponent(theme, "Model", items(), (value) => {
			selected = value;
		});
		picker.handleInput("\x1b[A");
		picker.handleInput("\r");
		expect(selected).toBe("b/two");
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(selected).toBe(null);
	});

	it("resolves undefined on escape", () => {
		let called = false;
		let selected: string | null | undefined = "sentinel" as string | null | undefined;
		const picker = new SearchPickerComponent(theme, "Model", items(), (value) => {
			called = true;
			selected = value;
		});
		picker.handleInput("\x1b");
		expect(called).toBe(true);
		expect(selected).toBeUndefined();
	});
});
