import { describe, expect, test, vi } from "vitest";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	STALE_EXTENSION_CONTEXT_MESSAGE,
	type ToolDefinition,
} from "../src/core/extensions/types.ts";
import {
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_DESCRIPTION_LENGTH,
	TODO_MAX_ITEMS,
	TODO_MAX_SUBJECT_LENGTH,
	TODO_TOOL_NAME,
	TODOS_COMMAND_NAME,
} from "../src/extensions/todo/constants.ts";
import todo from "../src/extensions/todo/index.ts";
import {
	EMPTY_TODO_STATE,
	TODO_DETAILS_SCHEMA_VERSION,
	type TodoDetails,
	type TodoItem,
	type TodoParams,
	type TodoParamsSchema,
	type TodoState,
} from "../src/extensions/todo/schema.ts";
import { createTodoStore, replayTodosFromBranch, type TodoStore } from "../src/extensions/todo/state.ts";

/** Cast arbitrary hostile values to the typed params surface. */
function params(value: unknown): TodoParams {
	return value as TodoParams;
}

function task(state: TodoState, id: number): TodoItem {
	const found = state.items.find((candidate) => candidate.id === id);
	expect(found).toBeDefined();
	return found as TodoItem;
}

function createStore(): TodoStore {
	return createTodoStore();
}

function createTasks(store: TodoStore, subjects: string[]): TodoDetails {
	return store.execute({
		action: "create",
		items: subjects.map((subject) => ({ subject, description: "Do it" })),
	});
}

describe("todo store create", () => {
	test("creates one or many tasks atomically, pending, in input order with monotonic ids", () => {
		const store = createStore();
		const one = createTasks(store, ["Wire parser"]);
		expect(one.change).toEqual({ kind: "create", ids: [1] });
		expect(one.state).toEqual({
			items: [{ id: 1, subject: "Wire parser", description: "Do it", status: "pending" }],
			nextId: 2,
		});

		const many = createTasks(store, ["Alpha", "Beta", "Gamma"]);
		expect(many.change).toEqual({ kind: "create", ids: [2, 3, 4] });
		expect(many.state.items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
		expect(many.state.items.slice(1).map((item) => item.subject)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(many.state.items.every((item) => item.status === "pending")).toBe(true);
		expect(many.state.nextId).toBe(5);
	});

	test("normalizes subject and description text", () => {
		const store = createStore();
		const details = store.execute({
			action: "create",
			items: [{ subject: "  Wire\t the   parser  ", description: "  done  when\nparser   passes " }],
		});
		expect(details.state.items[0]).toMatchObject({
			subject: "Wire the parser",
			description: "done when parser passes",
		});
	});

	test("enforces batch, capacity, and text bounds", () => {
		const store = createStore();
		createTasks(
			store,
			Array.from({ length: TODO_MAX_ITEMS }, (_, index) => `Task ${index + 1}`),
		);
		expect(() => createTasks(store, ["One more"])).toThrow(
			/todo list is full \(max 20 tasks\); delete completed or obsolete tasks first/,
		);
		expect(() =>
			createTasks(
				createStore(),
				Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => `Task ${index}`),
			),
		).toThrow(/items exceeds 20 tasks/);
		expect(() =>
			createStore().execute({
				action: "create",
				items: [{ subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1), description: "Do it" }],
			}),
		).toThrow(/subject exceeds 160 characters/);
		expect(() =>
			createStore().execute({
				action: "create",
				items: [{ subject: "Task", description: "x".repeat(TODO_MAX_DESCRIPTION_LENGTH + 1) }],
			}),
		).toThrow(/description exceeds 500 characters/);
		expect(() =>
			createStore().execute({
				action: "create",
				items: [{ subject: "   ", description: "Do it" }],
			}),
		).toThrow(/subject cannot be empty/);

		const exhausted = createTodoStore({ items: [], nextId: Number.MAX_SAFE_INTEGER });
		expect(() => createTasks(exhausted, ["No safe successor id"])).toThrow(/next id is exhausted/);
		expect(exhausted.getState()).toEqual({ items: [], nextId: Number.MAX_SAFE_INTEGER });
	});

	test("validates the whole batch before committing anything", () => {
		const store = createStore();
		expect(() =>
			store.execute({
				action: "create",
				items: [
					{ subject: "Good", description: "Do it" },
					{ subject: "", description: "Do it" },
				],
			}),
		).toThrow(/items\[1\]\.subject cannot be empty/);
		expect(store.getState()).toEqual(EMPTY_TODO_STATE);
	});

	test("rejects every inapplicable parameter per action", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const base = { action: "create", items: [{ subject: "Beta", description: "Do Beta" }] } as TodoParams;
		expect(() => store.execute(params({ ...base, id: 1 }))).toThrow(/id does not apply to action create/);
		expect(() => store.execute(params({ ...base, status: "pending" }))).toThrow(
			/status does not apply to action create/,
		);
		expect(() => store.execute(params({ ...base, subject: "Top level" }))).toThrow(
			/subject does not apply to action create/,
		);
		expect(() =>
			store.execute(params({ action: "update", id: 1, items: [{ subject: "x", description: "d" }] })),
		).toThrow(/items does not apply to action update/);
		expect(() => store.execute(params({ action: "update", id: 1, ids: [1] }))).toThrow(
			/ids does not apply to action update/,
		);
		expect(() => store.execute(params({ action: "list", id: 1 }))).toThrow(/id does not apply to action list/);
		expect(() => store.execute(params({ action: "list", items: [] }))).toThrow(/items does not apply to action list/);
		expect(() => store.execute(params({ action: "delete", ids: [1], id: 1 }))).toThrow(
			/id does not apply to action delete/,
		);
		expect(() => store.execute(params({ action: "delete", ids: [1], status: "pending" }))).toThrow(
			/status does not apply to action delete/,
		);
	});

	test("rejects unknown actions and tampered payloads without touching state", () => {
		const store = createStore();
		expect(() => store.execute(params({ action: "explode" }))).toThrow(/unknown todo action: explode/);
		expect(() => store.execute(params(null))).toThrow(/todo params must be an object/);
		expect(() => store.execute({ action: "create" })).toThrow(/items required for create/);
		expect(() => store.execute({ action: "create", items: [] })).toThrow(/items required for create/);
		expect(() => store.execute(params({ action: "create", items: ["nope"] }))).toThrow(
			/items\[0\] must be an object/,
		);
		expect(() =>
			store.execute(params({ action: "create", items: [{ subject: "A", description: "d", blockedBy: [1] }] })),
		).toThrow(/items\[0\]\.blockedBy does not apply to action create/);
		expect(() => store.execute(params({ action: "create", items: [{ subject: "A" }] }))).toThrow(
			/items\[0\]\.description must be a string/,
		);
		expect(store.getState()).toEqual(EMPTY_TODO_STATE);
	});
});

describe("todo store update", () => {
	test("updates subject, description, and status", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const renamed = store.execute({ action: "update", id: 1, subject: "Renamed" });
		expect(renamed.state.items[0]?.subject).toBe("Renamed");
		expect(renamed.change).toEqual({ kind: "update", id: 1, from: "pending", to: "pending" });

		const described = store.execute({ action: "update", id: 1, description: "Now verified" });
		expect(described.state.items[0]?.description).toBe("Now verified");

		const started = store.execute({ action: "update", id: 1, status: "in_progress" });
		expect(started.state.items[0]?.status).toBe("in_progress");
		expect(started.change).toEqual({ kind: "update", id: 1, from: "pending", to: "in_progress" });
	});

	test("requires at least one field and validates the id and status", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		expect(() => store.execute({ action: "update", id: 1 })).toThrow(
			/requires at least one of subject, description, or status/,
		);
		expect(() => store.execute({ action: "update", status: "pending" })).toThrow(/id required for update/);
		expect(() => store.execute({ action: "update", id: 42, status: "completed" })).toThrow(/#42 not found/);
		expect(() => store.execute(params({ action: "update", id: 1, status: "urgent" }))).toThrow(/status is invalid/);
		expect(() => store.execute({ action: "update", id: 1, subject: "   " })).toThrow(/subject cannot be empty/);
		expect(() =>
			store.execute({ action: "update", id: 1, subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1) }),
		).toThrow(/subject exceeds 160 characters/);
	});

	test("supports every transition, reopen, and idempotent updates", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		store.execute({ action: "update", id: 1, status: "in_progress" });
		const completed = store.execute({ action: "update", id: 1, status: "completed" });
		expect(completed.change).toEqual({ kind: "update", id: 1, from: "in_progress", to: "completed" });
		const reopened = store.execute({ action: "update", id: 1, status: "in_progress" });
		expect(reopened.change).toEqual({ kind: "update", id: 1, from: "completed", to: "in_progress" });
		const demoted = store.execute({ action: "update", id: 1, status: "pending" });
		expect(demoted.change).toEqual({ kind: "update", id: 1, from: "in_progress", to: "pending" });
		const same = store.execute({ action: "update", id: 1, status: "pending" });
		expect(same.change).toEqual({ kind: "update", id: 1, from: "pending", to: "pending" });
	});

	test("keeps exactly one active task and reports the demoted id", () => {
		const store = createStore();
		createTasks(store, ["First", "Second", "Third"]);
		store.execute({ action: "update", id: 1, status: "in_progress" });
		const details = store.execute({ action: "update", id: 2, status: "in_progress" });
		expect(details.change).toEqual({ kind: "update", id: 2, from: "pending", to: "in_progress", demotedId: 1 });
		expect(task(details.state, 1).status).toBe("pending");
		expect(task(details.state, 2).status).toBe("in_progress");
		expect(details.state.items.filter((item) => item.status === "in_progress")).toHaveLength(1);
	});

	test("leaves the store unchanged after failures and never leaks mutable snapshots", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const before = store.getState();
		expect(() => store.execute({ action: "update", id: 99, status: "completed" })).toThrow();
		expect(() => store.execute({ action: "update", id: 1 })).toThrow();
		expect(store.getState()).toEqual(before);

		const tampered = store.getState();
		tampered.items.push({ id: 99, subject: "Injected", description: "Do it", status: "pending" });
		tampered.items[0]!.subject = "Mutated";
		expect(store.getState()).toEqual(before);

		const listed = store.execute({ action: "list" });
		listed.state.items[0]!.description = "Mutated snapshot";
		expect(store.getState()).toEqual(before);
	});
});

describe("todo store delete", () => {
	test("removes ids in input order with duplicates ignored", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta", "Gamma", "Delta"]);
		const details = store.execute({ action: "delete", ids: [3, 1, 3, 1] });
		expect(details.change).toEqual({
			kind: "delete",
			removed: [
				{ id: 3, subject: "Gamma" },
				{ id: 1, subject: "Alpha" },
			],
		});
		expect(details.state.items.map((item) => item.id)).toEqual([2, 4]);
		expect(details.state.nextId).toBe(5);
	});

	test("fails atomically when any id is missing and hard-removes otherwise", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		expect(() => store.execute({ action: "delete", ids: [1, 9] })).toThrow(/#9 not found/);
		expect(() => store.execute({ action: "delete", ids: [9, 1] })).toThrow(/#9 not found/);
		expect(store.getState().items).toHaveLength(2);

		expect(() => store.execute({ action: "delete" })).toThrow(/ids required for delete/);
		expect(() => store.execute({ action: "delete", ids: [] })).toThrow(/ids required for delete/);
		expect(() =>
			store.execute({
				action: "delete",
				ids: Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => index + 1),
			}),
		).toThrow(/ids exceeds 20 ids/);
		expect(() => store.execute(params({ action: "delete", ids: [1.5] }))).toThrow(
			/ids must contain positive integer ids/,
		);

		const removed = store.execute({ action: "delete", ids: [1] });
		expect(removed.state.items.map((item) => item.id)).toEqual([2]);
		expect(removed.state.items.some((item) => item.id === 1)).toBe(false);
	});

	test("deleting the active task leaves no active task and nextId is never reused", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		store.execute({ action: "update", id: 1, status: "in_progress" });
		const details = store.execute({ action: "delete", ids: [1] });
		expect(details.state.items.some((item) => item.status === "in_progress")).toBe(false);
		expect(details.state.nextId).toBe(3);
		createTasks(store, ["Gamma"]);
		expect(task(store.getState(), 3).subject).toBe("Gamma");
	});

	test("list is read-only and accepts no parameters", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const details = store.execute({ action: "list" });
		expect(details.change).toEqual({ kind: "list" });
		expect(details.state.items).toEqual(store.getState().items);
		expect(() => store.execute(params({ action: "list", status: "pending" }))).toThrow(
			/status does not apply to action list/,
		);
		expect(() => store.execute(params({ action: "list", items: [] }))).toThrow(/items does not apply to action list/);
	});
});

describe("todo details", () => {
	test("carry exactly the v2 shape with no duplicated legacy params", () => {
		const store = createStore();
		const details = createTasks(store, ["Alpha"]);
		expect(details.schemaVersion).toBe(TODO_DETAILS_SCHEMA_VERSION);
		expect(details.schemaVersion).toBe(2);
		expect(Object.keys(details).sort()).toEqual(["change", "schemaVersion", "state"]);
		expect(details.change).toEqual({ kind: "create", ids: [1] });
		expect(details.state).toEqual({
			items: [{ id: 1, subject: "Alpha", description: "Do it", status: "pending" }],
			nextId: 2,
		});
	});
});

describe("replayTodosFromBranch", () => {
	function todoResult(details: unknown): unknown {
		return { type: "message", message: { role: "toolResult", toolName: TODO_TOOL_NAME, details } };
	}

	function v2Details(state: TodoState): unknown {
		return { schemaVersion: TODO_DETAILS_SCHEMA_VERSION, change: { kind: "list" }, state };
	}

	function branch(entries: unknown[]): { sessionManager: { getBranch(): Iterable<unknown> } } {
		return { sessionManager: { getBranch: () => entries } };
	}

	const validState: TodoState = {
		items: [{ id: 1, subject: "Wire parser", description: "Parser handles config", status: "pending" }],
		nextId: 2,
	};

	test("returns the empty state for an empty or unrelated branch", () => {
		expect(replayTodosFromBranch(branch([]))).toEqual(EMPTY_TODO_STATE);
		expect(
			replayTodosFromBranch(
				branch([
					{ type: "message", message: { role: "toolResult", toolName: "bash", details: { items: [1] } } },
					{ type: "message", message: { role: "user", content: [] } },
				]),
			),
		).toEqual(EMPTY_TODO_STATE);
	});

	test("replays the newest valid v2 snapshot and ignores v1 details", () => {
		const older: TodoState = {
			items: [{ id: 1, subject: "Old", description: "Do it", status: "pending" }],
			nextId: 2,
		};
		const newer: TodoState = {
			items: [...older.items, { id: 2, subject: "New", description: "Do it", status: "pending" }],
			nextId: 3,
		};
		const replayed = replayTodosFromBranch(
			branch([
				todoResult(v2Details(older)),
				todoResult({ schemaVersion: 1, action: "list", params: {}, items: [], nextId: 2 }),
				todoResult(v2Details(newer)),
			]),
		);
		expect(replayed).toEqual(newer);
	});

	test("ignores v1 snapshots entirely", () => {
		const v1 = {
			schemaVersion: 1,
			action: "list",
			params: {},
			items: [{ id: 1, subject: "Legacy", description: "Do it", status: "pending" }],
			nextId: 2,
		};
		expect(replayTodosFromBranch(branch([todoResult(v1)]))).toEqual(EMPTY_TODO_STATE);
	});

	test("falls back past a malformed newest snapshot to the last valid v2", () => {
		const malformed: unknown = {
			schemaVersion: 2,
			change: { kind: "list" },
			state: { items: [{ id: 1, subject: "Broken", description: "d", status: "pending" }], nextId: 1 },
		};
		const replayed = replayTodosFromBranch(branch([todoResult(v2Details(validState)), todoResult(malformed)]));
		expect(replayed).toEqual(validState);
	});

	test("rejects malformed snapshots of every kind", () => {
		const validItem = { id: 1, subject: "Task", description: "Do it", status: "pending" };
		const malformedStates: unknown[] = [
			{ items: [validItem, validItem], nextId: 2 }, // duplicate ids
			{ items: [{ ...validItem, id: 0 }], nextId: 2 }, // non-positive id
			{ items: [{ ...validItem, id: 1.5 }], nextId: 2 }, // non-integer id
			{ items: [{ ...validItem, subject: "" }], nextId: 2 }, // empty subject
			{ items: [{ ...validItem, subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1) }], nextId: 2 }, // oversized subject
			{ items: [{ ...validItem, subject: "  padded  " }], nextId: 2 }, // un-normalized text
			{ items: [{ ...validItem, description: "" }], nextId: 2 }, // empty description
			{ items: [{ ...validItem, description: "x".repeat(TODO_MAX_DESCRIPTION_LENGTH + 1) }], nextId: 2 },
			{ items: [{ ...validItem, status: "urgent" }], nextId: 2 }, // invalid status
			{
				items: [
					{ ...validItem, status: "in_progress" },
					{ ...validItem, id: 2, status: "in_progress" },
				],
				nextId: 3,
			}, // more than one active
			{ items: [validItem], nextId: 1 }, // nextId not past the max id
			{ items: [validItem], nextId: 1.5 }, // non-integer nextId
			{ items: "nope", nextId: 2 }, // items not an array
			{ items: [null], nextId: 2 }, // item not an object
			{
				items: Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, index) => ({ ...validItem, id: index + 1 })),
				nextId: TODO_MAX_ITEMS + 2,
			}, // over capacity
		];
		for (const state of malformedStates) {
			const replayed = replayTodosFromBranch(
				branch([todoResult({ schemaVersion: 2, change: { kind: "list" }, state })]),
			);
			expect(replayed).toEqual(EMPTY_TODO_STATE);
		}
	});

	test("stores are isolated instances and initial snapshots are cloned", () => {
		const first = createStore();
		const second = createStore();
		createTasks(first, ["Alpha"]);
		expect(second.getState()).toEqual(EMPTY_TODO_STATE);
		createTasks(second, ["Beta"]);
		expect(first.getState().items.map((item) => item.id)).toEqual([1]);
		expect(second.getState().items.map((item) => item.id)).toEqual([1]);

		const shared: TodoState = {
			items: [{ id: 7, subject: "Shared", description: "Do it", status: "pending" }],
			nextId: 8,
		};
		const third = createTodoStore(shared);
		shared.items.push({ id: 8, subject: "Injected", description: "Do it", status: "pending" });
		expect(third.getState().items.map((item) => item.id)).toEqual([7]);

		expect(() =>
			third.replaceState({
				items: [
					{ id: 1, subject: "One", description: "Do it", status: "in_progress" },
					{ id: 2, subject: "Two", description: "Do it", status: "in_progress" },
				],
				nextId: 3,
			}),
		).toThrow(/todo state is invalid/);
		expect(third.getState().items.map((item) => item.id)).toEqual([7]);
	});
});

describe("todo extension wiring", () => {
	type RegisteredTodoTool = ToolDefinition<typeof TodoParamsSchema, TodoDetails>;
	type CommandOptions = {
		description?: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	};

	function setup(): {
		commands: Map<string, CommandOptions>;
		handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>;
		tool: RegisteredTodoTool;
	} {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const commands = new Map<string, CommandOptions>();
		let tool: RegisteredTodoTool | undefined;
		const api = {
			registerTool: (definition: RegisteredTodoTool) => {
				tool = definition;
			},
			registerCommand: (name: string, options: CommandOptions) => {
				commands.set(name, options);
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		todo(api);
		if (!tool) throw new Error("todo tool was not registered");
		return { commands, handlers, tool };
	}

	test("registers the v2 tool schema, prompt, and sequential grouped execution", () => {
		const { tool } = setup();
		expect(tool.name).toBe(TODO_TOOL_NAME);
		expect(tool.label).toBe("Todo");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.toolGroup).toBe(TODO_TOOL_NAME);
		expect(tool.promptSnippet).toContain("task list");
		expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
		// The description carries mechanism only; when-to-use policy lives in the guidelines.
		expect(tool.description).toContain("create atomically adds 1-20 pending tasks");
		expect(tool.description).toContain("update edits one task by id");
		expect(tool.description).toContain("list returns every remaining task");
		expect(tool.description).toContain("delete removes 1-20 tasks by ids");
		expect(tool.description).toContain("at most 20 tasks including completed ones");
		expect(tool.description).toContain("ids are never reused");
		expect(tool.description).toContain("demotes any other active task");
		expect(tool.description).not.toMatch(/^##/m);
		expect(tool.promptGuidelines?.every((guideline) => guideline.includes("`todo`"))).toBe(true);
		for (const copy of [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]) {
			expect(copy).not.toMatch(/create_many|blockedBy|addBlocks|metadata|owner|dependency/);
		}
		expect(Object.keys(tool.parameters.properties).sort()).toEqual([
			"action",
			"description",
			"id",
			"ids",
			"items",
			"status",
			"subject",
		]);
	});

	test("execute returns v2 details and bounded content, and validation errors do not commit", async () => {
		const { tool } = setup();
		const ctx = {} as unknown as ExtensionContext;
		const created = await tool.execute(
			"call-1",
			{
				action: "create",
				items: [
					{ subject: "Wire parser", description: "Parser handles config" },
					{ subject: "Test parser", description: "Parser tests pass" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(created.content).toEqual([{ type: "text", text: "Created 2 tasks: #1: Wire parser; #2: Test parser" }]);
		expect(created.details.schemaVersion).toBe(2);
		expect(created.details.change).toEqual({ kind: "create", ids: [1, 2] });
		expect(created.details.state.items.map((item) => item.id)).toEqual([1, 2]);
		expect(created.details.state.nextId).toBe(3);

		await expect(
			tool.execute("call-2", { action: "update", id: 42, status: "completed" }, undefined, undefined, ctx),
		).rejects.toThrow(/#42 not found/);

		const listed = await tool.execute("call-3", { action: "list" }, undefined, undefined, ctx);
		expect(listed.content).toEqual([
			{
				type: "text",
				text: "Todos: 0 in progress, 2 pending, 0 completed\n[ ] #1 Wire parser\n    Parser handles config\n[ ] #2 Test parser\n    Parser tests pass",
			},
		]);
	});

	test("/todos shows the full list or a UI warning without one", async () => {
		const { commands, tool } = setup();
		const command = commands.get(TODOS_COMMAND_NAME);
		if (!command) throw new Error("todos command was not registered");
		expect(command.description).toBe("Show the complete todo list for the current conversation branch");

		await tool.execute(
			"call-1",
			{
				action: "create",
				items: [
					{ subject: "Wire parser", description: "Parser handles config" },
					{ subject: "Test parser", description: "Parser tests pass" },
				],
			},
			undefined,
			undefined,
			{} as unknown as ExtensionContext,
		);

		const notify = vi.fn();
		await command.handler("", { hasUI: true, ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(
			"Todos: 0 in progress, 2 pending, 0 completed\n[ ] #1 Wire parser\n    Parser handles config\n[ ] #2 Test parser\n    Parser tests pass",
			"info",
		);

		const notifyNoUI = vi.fn();
		await command.handler("", { hasUI: false, ui: { notify: notifyNoUI } } as unknown as ExtensionCommandContext);
		expect(notifyNoUI).toHaveBeenCalledWith("/todos requires an interactive UI.", "warning");
	});

	test("lifecycle replay swallows stale-context errors and propagates real ones", async () => {
		const { handlers } = setup();
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start handler missing");
		const event = { type: "session_start", reason: "startup" } as const;

		const stale = {
			hasUI: false,
			get sessionManager(): never {
				throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
			},
		} as unknown as ExtensionContext;
		await expect(start(event, stale)).resolves.toBeUndefined();

		const broken = {
			hasUI: false,
			sessionManager: {
				getBranch: () => {
					throw new Error("boom");
				},
			},
		} as unknown as ExtensionContext;
		await expect(start(event, broken)).rejects.toThrow("boom");
	});

	test("session_start/tree/shutdown and tool_execution_end drive widget registration", async () => {
		const { handlers, tool } = setup();
		const setWidget = vi.fn();
		const ui = { setWidget } as unknown as ExtensionUIContext;
		const branchCtx = {
			hasUI: true,
			ui,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: TODO_TOOL_NAME,
							details: {
								schemaVersion: 2,
								change: { kind: "list" },
								state: {
									items: [{ id: 1, subject: "Replayed", description: "Do it", status: "pending" }],
									nextId: 2,
								},
							},
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		const start = handlers.get("session_start");
		const tree = handlers.get("session_tree");
		const shutdown = handlers.get("session_shutdown");
		const end = handlers.get("tool_execution_end");
		if (!start || !tree || !shutdown || !end) throw new Error("missing lifecycle handlers");

		await start({ type: "session_start", reason: "startup" }, branchCtx);
		expect(setWidget).toHaveBeenCalledWith("todos", expect.any(Function), { placement: "aboveEditor" });

		// Non-todo and failed executions never touch the widget.
		const callsBefore = setWidget.mock.calls.length;
		await end(
			{ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: undefined, isError: false },
			branchCtx,
		);
		await end(
			{
				type: "tool_execution_end",
				toolCallId: "todo-1",
				toolName: TODO_TOOL_NAME,
				result: undefined,
				isError: true,
			},
			branchCtx,
		);
		expect(setWidget.mock.calls.length).toBe(callsBefore);

		// A successful todo execution that keeps tasks open stays registered.
		await tool.execute(
			"call-2",
			{ action: "create", items: [{ subject: "Added", description: "Do it" }] },
			undefined,
			undefined,
			branchCtx,
		);
		await end(
			{
				type: "tool_execution_end",
				toolCallId: "todo-2",
				toolName: TODO_TOOL_NAME,
				result: undefined,
				isError: false,
			},
			branchCtx,
		);
		expect(setWidget.mock.calls.length).toBe(callsBefore);

		// Completing every task unregisters the widget.
		await tool.execute("call-3", { action: "update", id: 1, status: "completed" }, undefined, undefined, branchCtx);
		await tool.execute("call-4", { action: "update", id: 2, status: "completed" }, undefined, undefined, branchCtx);
		await end(
			{
				type: "tool_execution_end",
				toolCallId: "todo-3",
				toolName: TODO_TOOL_NAME,
				result: undefined,
				isError: false,
			},
			branchCtx,
		);
		expect(setWidget).toHaveBeenCalledWith("todos", undefined);

		// Shutdown disposes the widget; a later tree event does nothing.
		await shutdown({ type: "session_shutdown", reason: "quit" }, branchCtx);
		const afterShutdown = setWidget.mock.calls.length;
		await tree({ type: "session_tree", newLeafId: null, oldLeafId: null }, branchCtx);
		expect(setWidget.mock.calls.length).toBe(afterShutdown);
	});
});
