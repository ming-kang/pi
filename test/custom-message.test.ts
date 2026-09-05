import { Container, MouseRegion, Spacer, Text, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

const message: CustomMessage = {
	role: "custom",
	customType: "test",
	content: "fallback content",
	display: true,
	timestamp: 0,
};

function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 0,
		y: 1,
		screenX: 0,
		screenY: 1,
		width: 40,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

const expandingRenderer: MessageRenderer = (_message, { expanded, outputPad }) =>
	new Text(expanded ? "summary\ndetails" : "summary", outputPad, 0);

function lines(component: Container): string[] {
	return component
		.render(40)
		.map(stripAnsi)
		.map((line) => line.trimEnd());
}

describe("CustomMessageComponent", () => {
	test("routes local clicks, excludes the spacer, and replaces regions without duplicates", () => {
		initTheme("dark");
		const component = new CustomMessageComponent(message, expandingRenderer, undefined, 0);
		const parent = new Container();
		parent.addChild(new Spacer(2));
		parent.addChild(component);
		parent.render(40);
		expect(parent.handleMouse(mouse({ y: 2 }))).toBeUndefined();
		const result = parent.handleMouse(mouse({ y: 3 }));
		expect(result).toMatchObject({ handled: true });
		expect(result?.capture).toBeUndefined();
		expect(result?.focus).toBeUndefined();
		expect(lines(component)).toEqual(["", "summary", "details"]);
		parent.render(40);
		expect(parent.handleMouse(mouse({ y: 4 }))?.handled).toBe(true);
		expect(lines(component)).toEqual(["", "summary"]);
		expect(component.children).toHaveLength(2);
	});

	test("shares expansion with setExpanded and retains it through padding and theme invalidation", () => {
		initTheme("dark");
		const component = new CustomMessageComponent(message, expandingRenderer, undefined, 0);
		component.setExpanded(true);
		component.render(40);
		component.handleMouse(mouse());
		expect(lines(component)).toEqual(["", "summary"]);
		component.handleMouse(mouse());
		component.setOutputPad(1);
		initTheme("light");
		component.invalidate();
		expect(lines(component)).toEqual(["", " summary", " details"]);
		component.setExpanded(false);
		expect(lines(component)).toEqual(["", " summary"]);
		expect(component.children).toHaveLength(2);
		initTheme("dark");
	});

	test("gives child mouse handlers priority and passes unhandled gestures through", () => {
		initTheme("dark");
		const onMouse = vi.fn((event: TuiMouseEvent) =>
			event.type === "click" && event.button === "left" ? { handled: true, render: false } : undefined,
		);
		const renderer = vi.fn<MessageRenderer>(() => new MouseRegion(new Text("child", 0, 0), onMouse));
		const component = new CustomMessageComponent(message, renderer);
		component.render(40);
		expect(component.handleMouse(mouse())).toMatchObject({ handled: true, render: false });
		expect(onMouse).toHaveBeenLastCalledWith(expect.objectContaining({ y: 0, height: 1 }));
		for (const event of [
			mouse({ type: "press" }),
			mouse({ type: "release" }),
			mouse({ type: "drag" }),
			mouse({ type: "move" }),
			mouse({ button: "right" }),
			mouse({ type: "wheel", wheelDelta: 1 }),
		]) {
			expect(component.handleMouse(event)).toBeUndefined();
		}
		expect(onMouse).toHaveBeenCalledTimes(7);
		expect(renderer).toHaveBeenCalledTimes(1);
	});

	test.each(["absent", "undefined", "throw"] as const)("leaves %s renderer fallback static", (mode) => {
		initTheme("dark");
		const renderer: MessageRenderer | undefined =
			mode === "absent"
				? undefined
				: () => {
						if (mode === "throw") throw new Error("renderer failed");
						return undefined;
					};
		const component = new CustomMessageComponent(message, renderer);
		const before = lines(component);
		expect(before.join("\n")).toContain("fallback content");
		for (let y = 0; y < before.length; y++) expect(component.handleMouse(mouse({ y }))).toBeUndefined();
		expect(lines(component)).toEqual(before);
	});

	test("removes a successful region when a later renderer call falls back", () => {
		initTheme("dark");
		const component = new CustomMessageComponent(message, (_message, { expanded }) =>
			expanded ? undefined : new Text("summary", 0, 0),
		);
		component.render(40);
		component.handleMouse(mouse());
		expect(lines(component).join("\n")).toContain("fallback content");
		expect(component.children).toHaveLength(2);
		expect(component.handleMouse(mouse({ y: 2 }))).toBeUndefined();
	});

	test("fullscreen SGR press/release schedules frames and toggles messages independently", async () => {
		initTheme("dark");
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const first = new CustomMessageComponent(message, expandingRenderer, undefined, 0);
		const second = new CustomMessageComponent(
			message,
			(_message, { expanded }) => new Text(expanded ? "second\nsecond details" : "second", 0, 0),
		);
		tui.addChild(first);
		tui.addChild(second);
		tui.start();
		try {
			await terminal.waitForRender();
			const clickLine = async (text: string) => {
				const row = terminal
					.getViewport()
					.map((line) => line.trimEnd())
					.indexOf(text);
				expect(row, JSON.stringify(terminal.getViewport().map((line) => line.trimEnd()))).toBeGreaterThanOrEqual(0);
				terminal.sendInput(`\x1b[<0;1;${row + 1}M`);
				terminal.sendInput(`\x1b[<0;1;${row + 1}m`);
				// Do not force a frame: handled clicks must request it via the public TUI.
				await terminal.waitForRender();
			};
			await clickLine("summary");
			expect(terminal.getViewport().map((line) => line.trimEnd())).toContain("details");
			expect(terminal.getViewport().map((line) => line.trimEnd())).not.toContain("second details");
			await clickLine("second");
			expect(terminal.getViewport().map((line) => line.trimEnd())).toContain("second details");
			await clickLine("details");
			expect(terminal.getViewport().map((line) => line.trimEnd())).not.toContain("details");
			expect(terminal.getViewport().map((line) => line.trimEnd())).toContain("second details");
			await clickLine("second details");
			expect(terminal.getViewport().map((line) => line.trimEnd())).not.toContain("second details");
			expect(first.children).toHaveLength(2);
			expect(second.children).toHaveLength(2);
		} finally {
			tui.stop();
		}
	});

	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});
