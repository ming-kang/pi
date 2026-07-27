import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatKeyLabel, keyLabel, keyText } from "../src/modes/interactive/components/keybinding-hints.ts";

describe("compact key labels", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("beautifies aliases, arrows, modifiers, and special keys", () => {
		expect(formatKeyLabel("escape")).toBe("Esc");
		expect(formatKeyLabel("return")).toBe("Enter");
		expect(formatKeyLabel("space")).toBe("Space");
		expect(formatKeyLabel("left")).toBe("←");
		expect(formatKeyLabel("pageDown")).toBe("PgDn");
		expect(formatKeyLabel("ctrl+shift+x")).toBe("Ctrl+Shift+X");
		expect(formatKeyLabel("alt+left")).toBe(`${process.platform === "darwin" ? "Option" : "Alt"}+←`);
	});

	it("does not confuse literal slash or plus keys with binding separators", () => {
		expect(formatKeyLabel("/")).toBe("/");
		expect(formatKeyLabel("+")).toBe("+");
		expect(formatKeyLabel("ctrl+/")).toBe("Ctrl+/");
		expect(formatKeyLabel("ctrl++")).toBe("Ctrl++");
	});

	it("shows only the first configured key without changing legacy keyText", () => {
		expect(keyLabel("tui.select.cancel")).toBe("Esc");
		expect(keyText("tui.select.cancel")).toBe("escape/ctrl+c");
	});

	it("supports injected managers and honest unbound fallbacks", () => {
		const custom = new KeybindingsManager({
			"tui.select.cancel": ["ctrl+q", "escape"],
		});
		expect(keyLabel("tui.select.cancel", { keybindings: custom })).toBe("Ctrl+Q");
		expect(keyLabel("app.session.new")).toBe("");
		expect(keyLabel("app.session.new", { fallback: "escape" })).toBe("Esc");
	});
});
