import { describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.ts";
import { keyDisplayText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { hotkeysTaskSection } from "../src/modes/interactive/interactive-mode.ts";

describe("hotkeysTaskSection", () => {
	// A task keybinding added to KEYBINDINGS never reaches `/hotkeys` unless this section lists it,
	// and the section must follow KEYBINDINGS rather than keep its own copy of the labels.
	it("lists both task detach scopes with their registered descriptions", () => {
		const section = hotkeysTaskSection((action) => keyDisplayText(action));
		expect(section).toContain("**Tasks**");
		expect(section).toContain(
			`| \`${keyDisplayText("app.tasks.detach")}\` | ${KEYBINDINGS["app.tasks.detach"].description} |`,
		);
		expect(section).toContain(
			`| \`${keyDisplayText("app.tasks.detachSelected")}\` | ${KEYBINDINGS["app.tasks.detachSelected"].description} (while /tasks is open) |`,
		);
	});
});
