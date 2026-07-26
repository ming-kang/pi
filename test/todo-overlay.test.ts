import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { TodoOverlay } from "../src/extensions/todo/overlay.ts";
import { EMPTY_TODO_STATE, type TodoParams, type TodoState } from "../src/extensions/todo/schema.ts";
import {
	applyTodoMutation,
	cloneState,
	commitTodoState,
	disposeTodoSession,
	setActiveTodoSession,
} from "../src/extensions/todo/state.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const SID = "sid-overlay";
const RECENT_COMPLETION_MS = 30_000;

const theme = {
	fg: (_color: string, text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

type WidgetComponent = { render: (width: number) => string[]; invalidate: () => void };
type WidgetFactory = (tui: unknown, theme: Theme) => WidgetComponent;

function mutate(state: TodoState, params: Partial<TodoParams> & { action: TodoParams["action"] }): TodoState {
	const result = applyTodoMutation(state, params as TodoParams);
	expect(result.operation.kind).not.toBe("error");
	return result.state;
}

function createTask(state: TodoState, subject: string): TodoState {
	return mutate(state, { action: "create", subject, description: `${subject} description` });
}

function makeUI() {
	const setWidget = vi.fn();
	const ui = { setWidget } as unknown as ExtensionUIContext;
	const lastFactory = (): WidgetFactory => {
		const calls = setWidget.mock.calls.filter((call) => call[1] !== undefined);
		expect(calls.length).toBeGreaterThan(0);
		return calls.at(-1)?.[1] as WidgetFactory;
	};
	const unregistered = (): boolean => setWidget.mock.calls.some((call) => call[1] === undefined);
	return { ui, setWidget, lastFactory, unregistered };
}

const tuiStub = { requestRender: vi.fn() };

describe("TodoOverlay", () => {
	let overlay: TodoOverlay;

	beforeEach(() => {
		vi.useFakeTimers();
		setActiveTodoSession(SID);
		commitTodoState(cloneState(EMPTY_TODO_STATE));
		overlay = new TodoOverlay();
	});

	afterEach(() => {
		overlay.dispose();
		disposeTodoSession(SID);
		vi.useRealTimers();
	});

	test("does not register a widget for an empty list", () => {
		const { ui, setWidget } = makeUI();
		overlay.setUI(ui);
		overlay.update();
		expect(setWidget).not.toHaveBeenCalled();
	});

	test("registers a widget and renders active work", () => {
		const { ui, lastFactory } = makeUI();
		commitTodoState(createTask(cloneState(EMPTY_TODO_STATE), "Live task"));
		overlay.setUI(ui);
		overlay.update();
		const component = lastFactory()(tuiStub, theme);
		expect(component.render(80).join("\n")).toContain("Live task");
	});

	test("replayed completions stay hidden", () => {
		const { ui, setWidget } = makeUI();
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Old done");
		state = mutate(state, { action: "update", id: 1, status: "completed" });
		commitTodoState(state);
		overlay.setUI(ui);
		overlay.resetVisibility();
		overlay.update();
		expect(setWidget).not.toHaveBeenCalled();
	});

	test("fresh completions stay visible for the confirmation window, then hide", () => {
		const { ui, lastFactory, unregistered } = makeUI();
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		commitTodoState(state);
		overlay.setUI(ui);
		overlay.update();
		const component = lastFactory()(tuiStub, theme);

		state = mutate(state, { action: "update", id: 1, status: "completed" });
		commitTodoState(state);
		overlay.update();
		expect(component.render(80).join("\n")).toContain("Task");

		vi.advanceTimersByTime(RECENT_COMPLETION_MS + 100);
		expect(unregistered()).toBe(true);
	});

	test("dispose unregisters the widget", () => {
		const { ui, setWidget, unregistered } = makeUI();
		commitTodoState(createTask(cloneState(EMPTY_TODO_STATE), "Task"));
		overlay.setUI(ui);
		overlay.update();
		expect(setWidget).toHaveBeenCalled();
		overlay.dispose();
		expect(unregistered()).toBe(true);
	});
});
