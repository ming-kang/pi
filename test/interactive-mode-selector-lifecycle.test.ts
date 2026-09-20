import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("InteractiveMode selector lifecycle", () => {
	test("disposes replaced and completed selectors exactly once", () => {
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const disposeActiveSelector = Reflect.get(InteractiveMode.prototype, "disposeActiveSelector") as (this: {
			activeSelectorToken?: object;
			activeSelectorDispose?: () => void;
		}) => void;
		const fakeThis = {
			activeSelectorToken: undefined as object | undefined,
			activeSelectorDispose: undefined as (() => void) | undefined,
			disposeActiveSelector,
			editor,
			editorContainer: new Container(),
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		};
		const showSelector = Reflect.get(InteractiveMode.prototype, "showSelector") as (
			this: typeof fakeThis,
			create: (done: () => void) => { component: typeof editor & { dispose: () => void }; focus: typeof editor },
		) => void;
		const first = { ...editor, dispose: vi.fn() };
		const second = { ...editor, dispose: vi.fn() };
		let finishFirst = () => {};
		let finishSecond = () => {};

		showSelector.call(fakeThis, (done) => {
			finishFirst = done;
			return { component: first, focus: first, dispose: first.dispose };
		});
		showSelector.call(fakeThis, (done) => {
			finishSecond = done;
			return { component: second, focus: second, dispose: second.dispose };
		});

		expect(first.dispose).toHaveBeenCalledTimes(1);
		finishFirst();
		expect(first.dispose).toHaveBeenCalledTimes(1);
		expect(fakeThis.editorContainer.children).toEqual([second]);

		finishSecond();
		finishSecond();
		expect(second.dispose).toHaveBeenCalledTimes(1);
		expect(fakeThis.editorContainer.children).toEqual([editor]);
	});

	test("clearing chat disposes a running Armin animation", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.3);
		const requestRender = vi.fn();
		const armin = new ArminComponent({ requestRender } as never);
		const dispose = vi.spyOn(armin, "dispose");
		const chatContainer = new Container();
		chatContainer.addChild(armin);
		const disposeChatComponents = Reflect.get(InteractiveMode.prototype, "disposeChatToolComponents") as (this: {
			chatContainer: Container;
		}) => void;

		disposeChatComponents.call({ chatContainer });
		chatContainer.clear();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(chatContainer.children).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(5000);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
