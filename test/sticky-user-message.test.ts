import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import {
	findStickyUserMessage,
	StickyUserMessageComponent,
} from "../src/modes/interactive/components/sticky-user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 80,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
		...overrides,
	};
}

describe("sticky user message selection", () => {
	test("uses the message first line, not whole-message visibility", () => {
		const anchors = [{ row: 10, summary: "first" }];

		expect(findStickyUserMessage(anchors, 9)).toBeUndefined();
		expect(findStickyUserMessage(anchors, 10)).toBeUndefined();
		expect(findStickyUserMessage(anchors, 11)).toEqual({ summary: "first", targetRow: 11 });
		expect(findStickyUserMessage(anchors, 30)).toEqual({ summary: "first", targetRow: 11 });
	});

	test("tracks the nearest message above the viewport and hides at every message head", () => {
		const anchors = [
			{ row: 10, summary: "first" },
			{ row: 20, summary: "second" },
		];

		expect(findStickyUserMessage(anchors, 15)).toEqual({ summary: "first", targetRow: 11 });
		expect(findStickyUserMessage(anchors, 20)).toBeUndefined();
		expect(findStickyUserMessage(anchors, 21)).toEqual({ summary: "second", targetRow: 21 });
	});
});

describe("StickyUserMessageComponent", () => {
	beforeEach(() => initTheme("dark"));

	test("renders one full-width user-message row only while a candidate exists", () => {
		const component = new StickyUserMessageComponent(
			() => 1,
			() => {},
		);
		expect(component.render(80)).toEqual([]);

		component.setJudgment({ summary: "first prompt", targetRow: 11 });
		const lines = component.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			theme.bg("userMessageBg", ` ${theme.fg("dim", "↑")} ${theme.fg("muted", "first prompt")}${" ".repeat(65)}`),
		);

		component.setJudgment(undefined);
		expect(component.render(80)).toEqual([]);
	});

	test("truncates wide text without dropping the background", () => {
		const component = new StickyUserMessageComponent(
			() => 1,
			() => {},
		);
		component.setJudgment({ summary: "中文 👩‍💻 details ".repeat(100), targetRow: 11 });
		const lines = component.render(20);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(20);
		expect(stripTerminalSequences(lines[0]!)).toContain("…");
		expect(lines[0]).not.toContain("\x1b[0m");
	});

	test("jumps on an unmodified left click and leaves other input alone", () => {
		let target: number | undefined;
		const component = new StickyUserMessageComponent(
			() => 1,
			(row) => {
				target = row;
			},
		);
		expect(component.handleMouse(mouse())).toBeUndefined();
		component.setJudgment({ summary: "first", targetRow: 11 });

		expect(component.handleMouse(mouse({ type: "wheel", button: "none" }))).toBeUndefined();
		expect(component.handleMouse(mouse({ shift: true }))).toBeUndefined();
		expect(component.handleMouse(mouse({ clickCount: 2 }))).toBeUndefined();
		expect(target).toBeUndefined();
		expect(component.handleMouse(mouse())).toEqual({ handled: true });
		expect(target).toBe(11);
	});
});
