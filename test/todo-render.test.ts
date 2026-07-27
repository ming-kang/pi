import { describe, expect, test } from "vitest";
import { EMPTY_TODO_STATE, type TodoParams, type TodoState } from "../src/extensions/todo/schema.ts";
import { applyTodoMutation, cloneState } from "../src/extensions/todo/state.ts";
import {
	formatCommandList,
	formatTodoCall,
	formatTodoGroupCall,
	hasVisibleOverlayItems,
	renderOverlayLines,
} from "../src/extensions/todo/view.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
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

	test("bounds command output and directs users to paged tool results", () => {
		let state = cloneState(EMPTY_TODO_STATE);
		for (let index = 1; index <= 55; index++) state = createTask(state, `Task ${index}`);
		const output = formatCommandList(state);
		expect(output).toContain("#50 Task 50");
		expect(output).not.toContain("#51 Task 51");
		expect(output).toContain("… and 5 more; use todo list with limit and afterId to page.");
	});
});

describe("formatTodoCall", () => {
	test("collapses a create to a single headline", () => {
		const line = formatTodoCall(
			{ action: "create", subject: "Fix login redirect", description: "Auth tests pass" },
			theme,
			false,
		);
		expect(line).toBe("todo create Fix login redirect");
	});

	test("expanded adds the parameters the result never echoes", () => {
		const lines = formatTodoCall(
			{
				action: "create",
				subject: "Fix login redirect",
				description: "Auth tests pass",
				activeForm: "fixing login redirect",
				blockedBy: [1, 2],
			},
			theme,
			true,
		).split("\n");
		expect(lines[0]).toBe("todo create Fix login redirect");
		expect(lines).toContain("description: Auth tests pass");
		expect(lines).toContain("activeForm: fixing login redirect");
		expect(lines).toContain("blockedBy: #1,#2");
	});

	test("shows id and target status for updates", () => {
		expect(formatTodoCall({ action: "update", id: 2, status: "in_progress" }, theme, false)).toBe(
			"todo update #2 in_progress",
		);
	});

	test("labels dependency-only updates", () => {
		expect(formatTodoCall({ action: "update", id: 3, addBlocks: [4] }, theme, false)).toBe(
			"todo update #3 dependencies",
		);
	});

	test("renders bare actions and status filters", () => {
		expect(formatTodoCall({ action: "list" }, theme, false)).toBe("todo list");
		expect(formatTodoCall({ action: "list", status: "pending" }, theme, false)).toBe("todo list pending");
		expect(formatTodoCall({ action: "delete", id: 7 }, theme, false)).toBe("todo delete #7");
	});

	test("tolerates partial and mistyped streaming args", () => {
		expect(formatTodoCall(undefined, theme, false)).toBe("todo");
		expect(formatTodoCall({}, theme, false)).toBe("todo");
		expect(formatTodoCall({ action: "create", subject: 42, status: "bogus" }, theme, false)).toBe("todo create");
		expect(formatTodoCall({ action: "update", id: 1.5, blockedBy: "nope" }, theme, false)).toBe("todo update");
	});

	test("includes create_many batch and list/clear parameters when expanded", () => {
		const batch = formatTodoCall(
			{
				action: "create_many",
				items: [
					{ subject: "Wire parser", description: "Parser handles config" },
					{ subject: "Test parser", description: "Parser tests pass" },
				],
			},
			theme,
			true,
		).split("\n");
		expect(batch[0]).toBe("todo create_many 2 tasks");
		expect(batch).toContain("batch: 2 tasks (Wire parser; Test parser)");

		const filters = formatTodoCall(
			{
				action: "list",
				includeDeleted: true,
				limit: 10,
				afterId: 5,
				query: "parser",
				unblockedOnly: true,
			},
			theme,
			true,
		);
		expect(filters).toContain("includeDeleted: true");
		expect(filters).toContain("limit: 10");
		expect(filters).toContain("afterId: 5");
		expect(filters).toContain("query: parser");
		expect(filters).toContain("unblockedOnly: true");
		expect(formatTodoCall({ action: "clear", confirm: true, expectedCount: 3 }, theme, true)).toContain(
			"expectedCount: 3",
		);
	});
});

describe("formatTodoGroupCall", () => {
	function completed(details: unknown) {
		return { isError: false, isPartial: false, result: { content: [], details } };
	}

	test("uses successful structured details for concise operation summaries", () => {
		expect(
			formatTodoGroupCall(
				{ action: "create_many", items: [{}, {}] },
				theme,
				completed({
					schemaVersion: 1,
					action: "create_many",
					operation: { kind: "create_many", ids: [4, 5] },
					items: [],
					nextId: 6,
				}),
			),
		).toBe("todo created 2 tasks #4, #5");
		expect(
			formatTodoGroupCall(
				{ action: "update", id: 4, status: "completed" },
				theme,
				completed({
					schemaVersion: 1,
					action: "update",
					operation: { kind: "update", id: 4, status: "completed" },
					items: [],
					nextId: 5,
				}),
			),
		).toBe("todo updated #4 completed");
		expect(
			formatTodoGroupCall(
				{ action: "list", status: "pending", limit: 1 },
				theme,
				completed({
					schemaVersion: 1,
					action: "list",
					operation: {
						kind: "list",
						status: "pending",
						limit: 1,
						statusCounts: { pending: 1 },
						resultCount: 1,
					},
					// The stored snapshot contains tasks that the filtered page did not return.
					items: [{ status: "pending" }, { status: "in_progress" }, { status: "deleted" }],
					nextId: 4,
				}),
			),
		).toBe("todo list: 1 pending");
		expect(
			formatTodoGroupCall(
				{ action: "get", id: 3 },
				theme,
				completed({
					schemaVersion: 1,
					action: "get",
					operation: { kind: "get", id: 3 },
					items: [{ id: 3, status: "in_progress" }],
					nextId: 4,
				}),
			),
		).toBe("todo get #3 in_progress");
		expect(
			formatTodoGroupCall(
				{ action: "delete", id: 3 },
				theme,
				completed({
					schemaVersion: 1,
					action: "delete",
					operation: { kind: "delete", id: 3 },
					items: [],
					nextId: 4,
				}),
			),
		).toBe("todo deleted #3");
		expect(
			formatTodoGroupCall(
				{ action: "clear", confirm: true, expectedCount: 2 },
				theme,
				completed({
					schemaVersion: 1,
					action: "clear",
					operation: { kind: "clear", count: 2 },
					items: [],
					nextId: 3,
				}),
			),
		).toBe("todo cleared 2 tasks");
	});

	test("falls back for partial or malformed details and bounds one-line failures", () => {
		const details = {
			schemaVersion: 1,
			action: "list",
			operation: { kind: "list" },
			items: "not an item list",
			nextId: 1,
		};
		expect(formatTodoGroupCall({ action: "list" }, theme, { ...completed(details), isPartial: true })).toBe(
			"todo list",
		);
		expect(formatTodoGroupCall({ action: "list" }, theme, completed(details))).toBe("todo list");

		const failure = formatTodoGroupCall({ action: "update", id: 7 }, theme, {
			isError: true,
			isPartial: false,
			result: { content: [{ type: "text", text: `bad request\n${"x".repeat(500)}` }], details: undefined },
		});
		expect(failure).toMatch(/^todo update #7 failed: bad request /);
		expect(failure).not.toContain("\n");
		expect(failure).not.toContain("x".repeat(200));
		expect(failure.length).toBeLessThanOrEqual(150);
	});
});
