import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 120;

function render(selector: ExtensionSelectorComponent): string {
	return stripAnsi(selector.render(WIDTH).join("\n"));
}

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders options and resolves the selected one", () => {
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Pick one:", ["A", "B"], onSelect, () => {});

		expect(render(selector)).toContain("A");
		selector.handleInput("j");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("B");
	});

	it("renders a subtitle under the title", () => {
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			["A"],
			() => {},
			() => {},
			{
				subtitle: "Context now 29% full",
			},
		);

		expect(render(selector)).toContain("Context now 29% full");
	});

	it("uses compact first-key labels and unified separators", () => {
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			["A"],
			() => {},
			() => {},
		);
		const output = render(selector);
		expect(output).toContain("↑/↓ navigate • Enter select • Esc cancel");
		expect(output).not.toContain("escape/ctrl+c");
	});

	it("reflects the first custom binding in both hints and input", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.up": ["ctrl+p", "up"],
				"tui.select.down": ["ctrl+n", "down"],
				"tui.select.confirm": ["ctrl+x", "enter"],
				"tui.select.cancel": ["ctrl+g", "escape"],
			}),
		);
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", ["A", "B"], onSelect, () => {});
		const output = render(selector);
		expect(output).toContain("Ctrl+P/Ctrl+N navigate • Ctrl+X select • Ctrl+G cancel");
		expect(output).not.toContain("Enter select");

		selector.handleInput("\x0e");
		selector.handleInput("\x18");
		expect(onSelect).toHaveBeenCalledWith("B");
	});

	it("wraps unified hints within narrow selector widths", () => {
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			["A"],
			() => {},
			() => {},
		);
		expect(selector.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
});
