import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AgentDefinition, AgentDiagnostic } from "../src/extensions/subagent/types.ts";
import { ProfilePickerComponent, type ProfilePickerResult } from "../src/extensions/subagent/ui/profile-picker.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function agent(name: string, description: string): AgentDefinition {
	return {
		name,
		description,
		tools: ["read"],
		systemPrompt: "Work",
		source: "builtin",
		filePath: `<builtin:${name}>`,
		backend: "sdk",
	};
}

function render(picker: ProfilePickerComponent, width = 120): string {
	return stripAnsi(picker.render(width).join("\n"));
}

const explorerDescription =
	"Fast read-only agent for finding files, searching code, and answering codebase questions without changing files.";
const profiles = [agent("general", "Implementation agent"), agent("explorer", explorerDescription)];

describe("Subagent profile picker", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("sorts title-cased labels alphabetically while returning internal names", () => {
		let result: ProfilePickerResult;
		const picker = new ProfilePickerComponent(theme, new KeybindingsManager(), profiles, [], (value) => {
			result = value;
		});
		const output = render(picker);
		expect(output.indexOf("Explorer")).toBeLessThan(output.indexOf("General"));
		expect(output).not.toContain("(default)");
		expect(output).toContain(explorerDescription);

		picker.handleInput("\r");
		expect(result).toEqual({ kind: "profile", name: "explorer" });
	});

	it("uses concise built-in UI copy instead of model-facing guidance", () => {
		const picker = new ProfilePickerComponent(
			theme,
			new KeybindingsManager(),
			[
				{
					...agent("explorer", "Model-facing guidance with quick, medium, and very thorough instructions."),
					uiDescription: "Fast read-only agent for finding files and answering codebase questions.",
				},
			],
			[],
			() => {},
		);
		const output = render(picker);
		expect(output).toContain("Fast read-only agent for finding files and answering codebase questions.");
		expect(output).not.toContain("very thorough instructions");
	});

	it("shows the full selected description and lets Text wrap it naturally", () => {
		const picker = new ProfilePickerComponent(theme, new KeybindingsManager(), profiles, [], () => {});
		const lines = picker.render(32);
		const output = stripAnsi(lines.join("\n")).replace(/\s+/gu, " ");
		expect(output).toContain(explorerDescription);
		expect(output).not.toContain("without changing…");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	it("filters profiles without changing their alphabetical order", () => {
		const picker = new ProfilePickerComponent(
			theme,
			new KeybindingsManager(),
			[agent("general", "Shared worker"), agent("explorer", "Shared worker"), agent("alpha-reviewer", "Unrelated")],
			[],
			() => {},
		);
		for (const character of "shared") picker.handleInput(character);
		const output = render(picker);
		expect(output).not.toContain("Alpha Reviewer");
		expect(output.indexOf("Explorer")).toBeLessThan(output.indexOf("General"));
	});

	it("wraps navigation and exposes diagnostics after profiles", () => {
		let result: ProfilePickerResult;
		const diagnostics: AgentDiagnostic[] = [{ path: "broken.md", message: "Invalid profile", source: "user" }];
		const picker = new ProfilePickerComponent(theme, new KeybindingsManager(), profiles, diagnostics, (value) => {
			result = value;
		});
		const output = render(picker);
		expect(output.indexOf("General")).toBeLessThan(output.indexOf("View 1 agent file issue"));

		picker.handleInput("\x1b[A");
		picker.handleInput("\r");
		expect(result).toEqual({ kind: "diagnostics" });
	});

	it("cancels with undefined", () => {
		let result: ProfilePickerResult = { kind: "diagnostics" };
		const picker = new ProfilePickerComponent(theme, new KeybindingsManager(), profiles, [], (value) => {
			result = value;
		});
		picker.handleInput("\x1b");
		expect(result).toBeUndefined();
	});
});
