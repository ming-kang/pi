import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 120;

const APPROVAL_OPTIONS = [
	{ label: "Start executing", description: "keep full context" },
	{ label: "Compact context, then execute", description: "best for long tasks" },
	{ label: "Keep planning" },
];

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

	it("renders each description on its own line under the label", () => {
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			APPROVAL_OPTIONS,
			() => {},
			() => {},
		);

		const lines = render(selector).split("\n");
		const labelIndex = lines.findIndex((line) => line.includes("Start executing"));

		expect(labelIndex).toBeGreaterThanOrEqual(0);
		expect(lines[labelIndex + 1]).toContain("keep full context");
		// An option without a description must not borrow the next one's line.
		expect(render(selector)).toContain("Keep planning");
	});

	it("resolves to the label, not the label plus description", () => {
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", APPROVAL_OPTIONS, onSelect, () => {});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith("Start executing");
	});

	it("navigates past descriptions one option at a time", () => {
		const onSelect = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", APPROVAL_OPTIONS, onSelect, () => {});

		selector.handleInput("j");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith("Compact context, then execute");
	});

	it("still accepts plain string options", () => {
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

	it("uses the cancel hint wording when dismissing is not destructive", () => {
		const withDefault = new ExtensionSelectorComponent(
			"Approve?",
			["A"],
			() => {},
			() => {},
		);
		expect(render(withDefault)).toContain("cancel");

		const withOverride = new ExtensionSelectorComponent(
			"Approve?",
			["A"],
			() => {},
			() => {},
			{
				cancelHint: "keep planning",
			},
		);
		const output = render(withOverride);
		expect(output).toContain("keep planning");
		expect(output).not.toContain("cancel");
	});
});
