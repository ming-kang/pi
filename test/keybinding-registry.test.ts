import { describe, expect, it } from "vitest";
import { registerKeybindings } from "../src/core/keybinding-registry.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
// Bundled extensions register their keybindings when their modules load.
import "../src/extensions/background/index.ts";
import "../src/extensions/btw/index.ts";
import "../src/extensions/provider/index.ts";
import "../src/extensions/question/index.ts";

describe("extension-owned keybindings", () => {
	it("resolves bundled extension bindings in managers created after their modules load", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.backgroundTasks.detach")).toEqual(["ctrl+b"]);
		expect(keybindings.getKeys("app.backgroundTasks.focusList")).toEqual(["left"]);
		expect(keybindings.getKeys("app.backgroundTasks.focusPreview")).toEqual(["right"]);
		expect(keybindings.getKeys("app.btw.close")).toEqual(["escape"]);
		expect(keybindings.getKeys("app.provider.removeEntry")).toEqual(["ctrl+x"]);
		expect(keybindings.getKeys("app.list.toggle")).toEqual(["space"]);
		// The detach key displaces the editor's secondary cursor-left binding.
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toEqual(["left"]);
		expect(keybindings.matches("\x02", "app.backgroundTasks.detach")).toBe(true);
		expect(keybindings.matches("\x02", "tui.editor.cursorLeft")).toBe(false);
	});

	it("lets keybindings.json override an extension binding like a core one", () => {
		const keybindings = new KeybindingsManager({ "app.btw.close": "ctrl+g" });
		expect(keybindings.getKeys("app.btw.close")).toEqual(["ctrl+g"]);
		expect(keybindings.getEffectiveConfig()["app.btw.close"]).toBe("ctrl+g");
	});

	it("accepts a shared binding registered again with the same definition and rejects a different one", () => {
		expect(() =>
			registerKeybindings({ "app.list.toggle": { defaultKeys: "space", description: "Toggle selected list item" } }),
		).not.toThrow();
		expect(() =>
			registerKeybindings({ "app.list.toggle": { defaultKeys: "enter", description: "Toggle selected list item" } }),
		).toThrow("app.list.toggle is already registered with a different definition");
	});
});
