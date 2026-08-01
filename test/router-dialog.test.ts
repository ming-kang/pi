import { type Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	createModelChecklist,
	createSearchableSelector,
	createThinkingMapEditor,
} from "../src/extensions/router/dialog.ts";
import { DEFAULT_THINKING_LEVEL_MAP } from "../src/extensions/router/presets.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const DOWN = "\x1b[B";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("router dialogs", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("keeps the searchable selector height stable while filtering", () => {
		const keybindings = new KeybindingsManager();
		const component = createSearchableSelector({
			title: "Models",
			items: [
				{ value: "gpt-5", label: "gpt-5" },
				{ value: "gpt-4", label: "gpt-4" },
			],
		})(createFakeTui(), theme, keybindings, () => {}) as Container & { handleInput: (data: string) => void };
		const before = component.render(100).length;
		component.handleInput("g");
		const after = component.render(100).length;

		expect(after).toBe(before);
	});

	it("filters and confirms the first native-style match", () => {
		let selected: string | undefined;
		const keybindings = new KeybindingsManager();
		const component = createSearchableSelector({
			title: "Models",
			items: [
				{ value: "gpt-5", label: "gpt-5" },
				{ value: "claude", label: "claude" },
			],
		})(createFakeTui(), theme, keybindings, (value) => {
			selected = value;
		}) as Container & { handleInput: (data: string) => void };

		for (const char of "claude") component.handleInput(char);
		component.handleInput(ENTER);
		expect(selected).toBe("claude");
	});

	it("persists checklist changes through the live-change callback", () => {
		const changes: string[][] = [];
		const results: Array<{ kind: "close"; selectedIds: string[] }> = [];
		const keybindings = new KeybindingsManager();
		const component = createModelChecklist({
			title: "Select models",
			models: [{ id: "gpt-5" }, { id: "gpt-4", unavailable: true }],
			initiallySelected: new Set(["gpt-5"]),
			onChange: (ids) => changes.push(ids),
		})(createFakeTui(), theme, keybindings, (result) => results.push(result)) as Container & {
			handleInput: (data: string) => void;
		};

		component.handleInput(SPACE);
		expect(changes).toEqual([[]]);
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("unsaved");
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		expect(changes).toEqual([[], ["gpt-4"]]);
		component.handleInput(ENTER);
		expect(results).toEqual([{ kind: "close", selectedIds: ["gpt-4"] }]);
	});

	it("shows only the five GPT Gateway thinking levels and toggles live", () => {
		const changes: Array<Record<string, string | null | undefined>> = [];
		const results: unknown[] = [];
		const keybindings = new KeybindingsManager();
		const component = createThinkingMapEditor({
			title: "Thinking",
			map: DEFAULT_THINKING_LEVEL_MAP,
			onChange: (map) => changes.push(map),
		})(createFakeTui(), theme, keybindings, (result) => results.push(result)) as Container & {
			handleInput: (data: string) => void;
		};
		const output = stripAnsi(component.render(100).join("\n"));

		expect(output).toContain("low");
		expect(output).toContain("medium");
		expect(output).toContain("high");
		expect(output).toContain("xhigh");
		expect(output).toContain("max");
		expect(output).not.toContain("minimal");
		expect(output).not.toContain("off");

		component.handleInput(SPACE);
		expect(changes[0]?.low).toBeNull();
		component.handleInput(ESC);
		expect(results).toHaveLength(1);
	});
});
