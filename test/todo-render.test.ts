import { describe, expect, test } from "vitest";
import { EMPTY_TODO_STATE, type TodoParams, type TodoState } from "../src/extensions/todo/schema.ts";
import { applyTodoMutation, cloneState } from "../src/extensions/todo/state.ts";
import { formatCommandList, hasVisibleOverlayItems, renderOverlayLines } from "../src/extensions/todo/view.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

const WIDTH = 120;

function mutate(state: TodoState, params: Partial<TodoParams> & { action: TodoParams["action"] }): TodoState {
	const result = applyTodoMutation(state, params as TodoParams);
	expect(result.operation.kind).not.toBe("error");
	return result.state;
}

function createTask(state: TodoState, subject: string, extra: Partial<TodoParams> = {}): TodoState {
	return mutate(state, { action: "create", subject, description: `${subject} description`, ...extra });
}

describe("renderOverlayLines", () => {
	test("returns nothing for an empty state", () => {
		expect(renderOverlayLines(cloneState(EMPTY_TODO_STATE), theme, WIDTH, new Set())).toEqual([]);
	});

	test("heading counts completed over total visible tasks", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "First");
		state = createTask(state, "Second");
		state = mutate(state, { action: "update", id: 1, status: "completed" });
		const lines = renderOverlayLines(state, theme, WIDTH, new Set());
		expect(lines[0]).toContain("Todos");
		expect(lines[0]).toContain("(1/2)");
	});

	test("hidden completed tasks are filtered from the body", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Done");
		state = mutate(state, { action: "update", id: 1, status: "completed" });
		expect(hasVisibleOverlayItems(state, new Set([1]))).toBe(false);
		expect(renderOverlayLines(state, theme, WIDTH, new Set([1]))).toEqual([]);
		expect(hasVisibleOverlayItems(state, new Set())).toBe(true);
	});

	test("shows activeForm for the in_progress task", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task", { activeForm: "doing the task" });
		state = mutate(state, { action: "update", id: 1, status: "in_progress" });
		const body = renderOverlayLines(state, theme, WIDTH, new Set()).join("\n");
		expect(body).toContain("(doing the task)");
	});

	test("flags unresolved dependencies and shows ids when edges exist", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Blocked", { blockedBy: [1] });
		const body = renderOverlayLines(state, theme, WIDTH, new Set()).join("\n");
		expect(body).toContain("#2");
		expect(body).toContain("blocked by #1");
		expect(body).toContain("(deps incomplete)");
	});

	test("orders the active task first and summarizes the overflow", () => {
		let state = cloneState(EMPTY_TODO_STATE);
		for (let i = 0; i < 12; i++) state = createTask(state, `Task ${i + 1}`);
		state = mutate(state, { action: "update", id: 12, status: "in_progress" });
		const lines = renderOverlayLines(state, theme, WIDTH, new Set());
		expect(lines[1]).toContain("Task 12");
		expect(lines.at(-2)).toContain("+3 more");
		expect(lines.at(-2)).toContain("pending");
	});
});

describe("formatCommandList", () => {
	test("reports an empty list", () => {
		expect(formatCommandList(cloneState(EMPTY_TODO_STATE))).toBe("No todos yet.");
	});

	test("groups by status and annotates owner and unresolved deps", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Blocked", { blockedBy: [1], owner: "agent-a" });
		state = createTask(state, "Active", { activeForm: "working" });
		state = mutate(state, { action: "update", id: 3, status: "in_progress" });
		const text = formatCommandList(state);
		const lines = text.split("\n");
		expect(lines[0]).toBe("in_progress");
		expect(text).toContain("(working)");
		expect(text).toContain("@agent-a");
		expect(text).toContain("blocked by #1");
	});

	test("tombstones stay out of the command list", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Gone");
		state = mutate(state, { action: "delete", id: 1 });
		expect(formatCommandList(state)).toBe("No todos yet.");
	});
});
