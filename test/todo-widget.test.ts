import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { EMPTY_TODO_STATE, type TodoItem, type TodoState } from "../src/extensions/todo/schema.ts";
import { TodoWidget } from "../src/extensions/todo/widget.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const WIDGET_KEY = "todos";

type WidgetComponent = { render(width: number): string[]; invalidate(): void };
type WidgetContent = ((tui: TUI, theme: Theme) => WidgetComponent) | undefined;

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function makeUI(): {
	setWidget: ReturnType<typeof vi.fn<(key: string, content: WidgetContent, options?: { placement: string }) => void>>;
	ui: ExtensionUIContext;
} {
	const setWidget = vi.fn<(key: string, content: WidgetContent, options?: { placement: string }) => void>();
	const ui = { setWidget } as unknown as ExtensionUIContext;
	return { setWidget, ui };
}

function openTask(id: number, status: "pending" | "in_progress" = "pending"): TodoItem {
	return { id, subject: `Task ${id}`, description: `Do ${id}`, status };
}

function registeredFactory(
	setWidget: ReturnType<typeof makeUI>["setWidget"],
): (tui: TUI, theme: Theme) => WidgetComponent {
	const call = setWidget.mock.calls.find((entry) => entry[1] !== undefined);
	const content = call?.[1];
	if (!content) throw new Error("widget factory was not registered");
	return content;
}

describe("TodoWidget", () => {
	test("does not register while no task is open", () => {
		const { setWidget, ui } = makeUI();
		const widget = new TodoWidget(() => EMPTY_TODO_STATE);
		widget.setUI(ui);
		widget.update();
		expect(setWidget).not.toHaveBeenCalled();
	});

	test("registers above the editor for pending and in_progress tasks", () => {
		for (const status of ["pending", "in_progress"] as const) {
			const { setWidget, ui } = makeUI();
			const widget = new TodoWidget(() => ({ items: [openTask(1, status)], nextId: 2 }));
			widget.setUI(ui);
			widget.update();
			expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
			widget.dispose();
		}
	});

	test("does not register when every task is completed", () => {
		const { setWidget, ui } = makeUI();
		const widget = new TodoWidget(() => ({
			items: [{ ...openTask(1), status: "completed" }],
			nextId: 2,
		}));
		widget.setUI(ui);
		widget.update();
		expect(setWidget).not.toHaveBeenCalled();
	});

	test("unregisters as soon as the last open task completes", () => {
		const { setWidget, ui } = makeUI();
		let widgetState: TodoState = { items: [openTask(1)], nextId: 2 };
		const widget = new TodoWidget(() => widgetState);
		widget.setUI(ui);
		widget.update();
		expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });

		widgetState = { items: [{ ...openTask(1), status: "completed" }], nextId: 2 };
		widget.update();
		expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	test("renders exactly one line", () => {
		const { setWidget, ui } = makeUI();
		const widget = new TodoWidget(() => ({ items: [openTask(1)], nextId: 2 }));
		widget.setUI(ui);
		widget.update();
		const component = registeredFactory(setWidget)({ requestRender: () => {} } as unknown as TUI, theme);
		expect(component.render(80)).toHaveLength(1);
		expect(component.render(80)[0]).toContain("#1");
		expect(component.render(1)).toHaveLength(1);
	});

	test("requests a redraw while registered and never re-registers", () => {
		const { setWidget, ui } = makeUI();
		const requestRender = vi.fn();
		const widget = new TodoWidget(() => ({ items: [openTask(1)], nextId: 2 }));
		widget.setUI(ui);
		widget.update();
		registeredFactory(setWidget)({ requestRender } as unknown as TUI, theme);
		widget.update();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(setWidget.mock.calls).toHaveLength(1);
	});

	test("invalidate leaves registration and rendering untouched", () => {
		const { setWidget, ui } = makeUI();
		const widget = new TodoWidget(() => ({ items: [openTask(1)], nextId: 2 }));
		widget.setUI(ui);
		widget.update();
		const component = registeredFactory(setWidget)({ requestRender: () => {} } as unknown as TUI, theme);
		component.invalidate();
		component.invalidate();
		expect(setWidget.mock.calls).toHaveLength(1);
		expect(component.render(80)).toHaveLength(1);
	});

	test("setUI swaps to the new UI and disposes the previous registration", () => {
		const first = makeUI();
		const second = makeUI();
		const widget = new TodoWidget(() => ({ items: [openTask(1)], nextId: 2 }));
		widget.setUI(first.ui);
		widget.update();
		expect(first.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });

		widget.setUI(second.ui);
		expect(first.setWidget).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		widget.update();
		expect(second.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
	});

	test("dispose unregisters and later updates are no-ops", () => {
		const { setWidget, ui } = makeUI();
		const widget = new TodoWidget(() => ({ items: [openTask(1)], nextId: 2 }));
		widget.setUI(ui);
		widget.update();
		widget.dispose();
		expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		widget.dispose();
		widget.update();
		expect(setWidget.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(1);
	});

	test("uses no timers: registration follows state synchronously", () => {
		// The widget keeps no timers, completion windows, or caches, so this suite
		// never needs fake timers: registration changes happen inline with update().
		const { setWidget, ui } = makeUI();
		let widgetState: TodoState = { items: [openTask(1)], nextId: 2 };
		const widget = new TodoWidget(() => widgetState);
		widget.setUI(ui);
		widget.update();
		expect(setWidget.mock.calls).toHaveLength(1);
		widgetState = { items: [], nextId: 2 };
		widget.update();
		expect(setWidget).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		widgetState = { items: [openTask(2)], nextId: 3 };
		widget.update();
		expect(setWidget.mock.calls.filter((call) => call[1] !== undefined)).toHaveLength(2);
	});
});
