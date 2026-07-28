import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { ArminComponent } from "../src/modes/interactive/components/armin.ts";
import { CountdownTimer } from "../src/modes/interactive/components/countdown-timer.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeSession(modified: Date): SessionInfo {
	return {
		path: "/tmp/session.jsonl",
		id: "session",
		cwd: "/tmp",
		created: modified,
		modified,
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

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

describe("CountdownTimer", () => {
	test("expires from its wall-clock deadline after an event-loop stall", async () => {
		let now = new Date("2026-03-28T12:00:00.000Z").getTime();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const ticks: number[] = [];
		const onExpire = vi.fn();
		const requestRender = vi.fn();

		const timer = new CountdownTimer(5000, { requestRender } as never, (seconds) => ticks.push(seconds), onExpire);
		expect(ticks).toEqual([5]);

		// Simulate the process waking after the deadline before the next interval callback.
		now += 7000;
		await vi.advanceTimersByTimeAsync(1000);

		expect(ticks).toEqual([5, 0]);
		expect(onExpire).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(5000);
		expect(onExpire).toHaveBeenCalledTimes(1);
		timer.dispose();
	});

	test("aligns display updates and expiry to a fractional deadline", async () => {
		vi.setSystemTime(new Date("2026-03-28T12:00:00.000Z"));
		const ticks: number[] = [];
		const onExpire = vi.fn();
		new CountdownTimer(1500, undefined, (seconds) => ticks.push(seconds), onExpire);

		expect(ticks).toEqual([2]);
		await vi.advanceTimersByTimeAsync(499);
		expect(ticks).toEqual([2]);
		await vi.advanceTimersByTimeAsync(1);
		expect(ticks).toEqual([2, 1]);
		await vi.advanceTimersByTimeAsync(999);
		expect(onExpire).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(ticks).toEqual([2, 1, 0]);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	test("expires a zero-duration deadline without waiting one second", async () => {
		const ticks: number[] = [];
		const onExpire = vi.fn();
		new CountdownTimer(0, undefined, (seconds) => ticks.push(seconds), onExpire);

		expect(ticks).toEqual([0]);
		expect(onExpire).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});
});

describe("ArminComponent rain", () => {
	test("settles empty bitmap columns and stops requesting renders", async () => {
		// 0.3 selects the rain effect and makes all random drop offsets deterministic.
		vi.spyOn(Math, "random").mockReturnValue(0.3);
		const requestRender = vi.fn();
		const component = new ArminComponent({ requestRender } as never);

		await vi.advanceTimersByTimeAsync(30_000);
		const rendersAfterSettling = requestRender.mock.calls.length;
		expect(rendersAfterSettling).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(5000);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterSettling);
		component.dispose();
	});
});

describe("InteractiveMode selector lifecycle", () => {
	test("disposes replaced and completed selectors exactly once", () => {
		const editor = { render: () => ["editor"], invalidate: () => {} };
		const fakeThis = {
			activeSelector: null,
			activeSelectorCleanup: null,
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
			return { component: first, focus: first };
		});
		showSelector.call(fakeThis, (done) => {
			finishSecond = done;
			return { component: second, focus: second };
		});

		expect(first.dispose).toHaveBeenCalledTimes(1);
		finishFirst();
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

describe("SessionSelectorComponent relative ages", () => {
	test("refreshes each minute while open and stops after disposal", async () => {
		const openedAt = new Date("2026-03-28T12:00:30.000Z");
		vi.setSystemTime(openedAt);
		const session = makeSession(new Date(openedAt.getTime() - 30_000));
		const requestRender = vi.fn();
		const selector = new SessionSelectorComponent(
			async () => [session],
			async () => [session],
			() => {},
			() => {},
			() => {},
			requestRender,
		);
		await flushPromises();

		expect(selector.render(120).join("\n")).toContain("now");
		const initialRenderRequests = requestRender.mock.calls.length;

		await vi.advanceTimersByTimeAsync(60_000);
		expect(requestRender).toHaveBeenCalledTimes(initialRenderRequests + 1);
		expect(selector.render(120).join("\n")).toContain("1m");

		selector.dispose();
		selector.dispose();
		const requestsAfterDisposal = requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(requestRender).toHaveBeenCalledTimes(requestsAfterDisposal);
	});
});
