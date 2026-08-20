import { type Component, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { RouterTuiSession } from "../src/extensions/router/dialog-host.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

class TestScreen implements Component {
	focused = false;
	disposed = false;

	render(): string[] {
		return ["screen"];
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}
}

describe("RouterTuiSession", () => {
	beforeAll(() => initTheme("dark"));

	it("serializes child dialogs and disposes each replaced screen", async () => {
		const tui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
		const session = new RouterTuiSession(tui, theme, new KeybindingsManager(), vi.fn());
		const firstScreen = new TestScreen();
		let finishFirst: (value: string) => void = () => {
			throw new Error("first dialog was not mounted");
		};
		const first = session.show<string>((_tui, _theme, _keybindings, done) => {
			finishFirst = done;
			return firstScreen;
		});
		await Promise.resolve();

		await expect(
			session.show((_tui, _theme, _keybindings, done) => {
				done(undefined);
				return new TestScreen();
			}),
		).rejects.toThrow("already has an active dialog");

		finishFirst("first");
		await expect(first).resolves.toBe("first");
		const secondScreen = new TestScreen();
		let finishSecond: (value: string) => void = () => {
			throw new Error("second dialog was not mounted");
		};
		const second = session.show<string>((_tui, _theme, _keybindings, done) => {
			finishSecond = done;
			return secondScreen;
		});
		await Promise.resolve();
		expect(firstScreen.disposed).toBe(true);

		finishSecond("second");
		await expect(second).resolves.toBe("second");
		session.dispose();
		expect(secondScreen.disposed).toBe(true);
	});
});
