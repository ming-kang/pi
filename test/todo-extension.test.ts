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
		create: subjects.map((subject) => ({ subject, description: "Do it" })),
	});
}

describe("todo store create", () => {
	test("creates one or many tasks atomically, pending by default, in input order with monotonic ids", () => {
		const store = createStore();
		const one = createTasks(store, ["Wire parser"]);
		expect(one.change).toEqual({ created: [1], updated: [], deleted: [], absent: [], evicted: [] });
		expect(one.state).toEqual({
			items: [{ id: 1, subject: "Wire parser", description: "Do it", status: "pending" }],
			nextId: 2,
		});

		const many = createTasks(store, ["Alpha", "Beta", "Gamma"]);
		expect(many.change.created).toEqual([2, 3, 4]);
		expect(many.state.items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
		expect(many.state.items.slice(1).map((item) => item.subject)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(many.state.items.every((item) => item.status === "pending")).toBe(true);
		expect(many.state.nextId).toBe(5);
	});

	test("accepts an explicit status on create, including in_progress", () => {
		const store = createStore();
		const details = store.execute({
			create: [
				{ subject: "Wire parser", description: "Do it", status: "in_progress" },
				{ subject: "Test parser", description: "Do it", status: "completed" },
			],
		});
		expect(task(details.state, 1).status).toBe("in_progress");
		expect(task(details.state, 2).status).toBe("completed");
	});

	test("normalizes subject and description text", () => {
		const store = createStore();
		const details = store.execute({
			create: [{ subject: "  Wire\t the   parser  ", description: "  done  when\nparser   passes " }],
		});
		expect(details.state.items[0]).toMatchObject({
			subject: "Wire the parser",
			description: "done when parser passes",
		});
	});

	test("enforces batch and text bounds", () => {
		expect(() =>
			createTasks(
				createStore(),
				Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => `Task ${index}`),
			),
		).toThrow(/create exceeds 20 tasks/);
		expect(() =>
			createStore().execute({
				create: [{ subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1), description: "Do it" }],
			}),
		).toThrow(/create\[0\]\.subject exceeds 160 characters/);
		expect(() =>
			createStore().execute({
				create: [{ subject: "Task", description: "x".repeat(TODO_MAX_DESCRIPTION_LENGTH + 1) }],
			}),
		).toThrow(/create\[0\]\.description exceeds 500 characters/);
		expect(() =>
			createStore().execute({
				create: [{ subject: "   ", description: "Do it" }],
			}),
		).toThrow(/create\[0\]\.subject cannot be empty/);

		const exhausted = createTodoStore({ items: [], nextId: Number.MAX_SAFE_INTEGER });
		expect(() => createTasks(exhausted, ["No safe successor id"])).toThrow(/next id is exhausted/);
		expect(exhausted.getState()).toEqual({ items: [], nextId: Number.MAX_SAFE_INTEGER });
	});

	test("validates the whole batch before committing anything", () => {
		const store = createStore();
		expect(() =>
			store.execute({
				create: [
					{ subject: "Good", description: "Do it" },
					{ subject: "", description: "Do it" },
				],
			}),
		).toThrow(/create\[1\]\.subject cannot be empty/);
		expect(store.getState()).toEqual(EMPTY_TODO_STATE);
	});

	test("rejects tampered payloads without touching state", () => {
		const store = createStore();
		expect(() => store.execute(params(null))).toThrow(/todo params must be an object/);
		expect(() => store.execute(params({ items: [{ subject: "A", description: "d" }] }))).toThrow(
			/unknown todo field "items"; valid fields: create, update, delete/,
		);
		expect(() => store.execute(params({ action: "create", create: [] }))).toThrow(/unknown todo field "action"/);
		expect(() => store.execute(params({ create: ["nope"] }))).toThrow(/create\[0\] must be an object/);
		expect(() => store.execute(params({ create: "nope" }))).toThrow(/create must be an array/);
		expect(() => store.execute(params({ create: [{ subject: "A", description: "d", blockedBy: [1] }] }))).toThrow(
			/create\[0\]\.blockedBy is not a create field; valid fields: subject, description, status/,
		);
		expect(() => store.execute(params({ create: [{ subject: "A" }] }))).toThrow(
			/create\[0\]\.description must be a string/,
		);
		expect(() => store.execute(params({ create: [{ subject: "A", description: "d", status: "urgent" }] }))).toThrow(
			/create\[0\]\.status is invalid/,
		);
		expect(store.getState()).toEqual(EMPTY_TODO_STATE);
	});
});

describe("todo store update", () => {
	test("updates subject, description, and status", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const renamed = store.execute({ update: [{ id: 1, subject: "Renamed" }] });
		expect(renamed.state.items[0]?.subject).toBe("Renamed");
		expect(renamed.change.updated).toEqual([{ id: 1, from: "pending", to: "pending" }]);

		const described = store.execute({ update: [{ id: 1, description: "Now verified" }] });
		expect(described.state.items[0]?.description).toBe("Now verified");

		const started = store.execute({ update: [{ id: 1, status: "in_progress" }] });
		expect(started.state.items[0]?.status).toBe("in_progress");
		expect(started.change.updated).toEqual([{ id: 1, from: "pending", to: "in_progress" }]);
	});

	test("updates many tasks in one call", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		const details = store.execute({
			update: [
				{ id: 1, status: "completed" },
				{ id: 2, subject: "Beta v2" },
			],
		});
		expect(task(details.state, 1).status).toBe("completed");
		expect(task(details.state, 2).subject).toBe("Beta v2");
		expect(details.change.updated).toEqual([
			{ id: 1, from: "pending", to: "completed" },
			{ id: 2, from: "pending", to: "pending" },
		]);
	});

	test("blank or omitted fields keep the current values and no-op entries are accepted", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		store.execute({ update: [{ id: 1, subject: "Kept subject", description: "Kept description" }] });
		const blanked = store.execute({ update: [{ id: 1, subject: "   ", description: "" }] });
		expect(task(blanked.state, 1).subject).toBe("Kept subject");
		expect(task(blanked.state, 1).description).toBe("Kept description");

		const noop = store.execute({ update: [{ id: 1 }] });
		expect(task(noop.state, 1).subject).toBe("Kept subject");
		expect(noop.change.updated).toEqual([{ id: 1, from: "pending", to: "pending" }]);
	});

	test("supports every transition, reopen, and idempotent updates", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		store.execute({ update: [{ id: 1, status: "in_progress" }] });
		const completed = store.execute({ update: [{ id: 1, status: "completed" }] });
		expect(completed.change.updated).toEqual([{ id: 1, from: "in_progress", to: "completed" }]);
		const reopened = store.execute({ update: [{ id: 1, status: "in_progress" }] });
		expect(reopened.change.updated).toEqual([{ id: 1, from: "completed", to: "in_progress" }]);
		const demoted = store.execute({ update: [{ id: 1, status: "pending" }] });
		expect(demoted.change.updated).toEqual([{ id: 1, from: "in_progress", to: "pending" }]);
	});

	test("keeps exactly one active task and reports the demoted id", () => {
		const store = createStore();
		createTasks(store, ["First", "Second", "Third"]);
		store.execute({ update: [{ id: 1, status: "in_progress" }] });
		const details = store.execute({ update: [{ id: 2, status: "in_progress" }] });
		expect(details.change.updated).toEqual([{ id: 2, from: "pending", to: "in_progress" }]);
		expect(details.change.demotedId).toBe(1);
		expect(task(details.state, 1).status).toBe("pending");
		expect(task(details.state, 2).status).toBe("in_progress");
		expect(details.state.items.filter((item) => item.status === "in_progress")).toHaveLength(1);
	});

	test("rejects unknown ids with the current id list, duplicates, and conflicts with delete", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		expect(() => store.execute({ update: [{ id: 42, status: "completed" }] })).toThrow(
			/#42 not found; current ids: #1, #2/,
		);
		expect(() => createStore().execute({ update: [{ id: 42 }] })).toThrow(/#42 not found; the list is empty/);
		expect(() => store.execute({ update: [{ id: 1 }, { id: 1, status: "completed" }] })).toThrow(
			/#1 appears more than once in update/,
		);
		expect(() => store.execute({ update: [{ id: 1, status: "completed" }], delete: [1] })).toThrow(
			/#1 cannot be in both update and delete/,
		);
		expect(store.getState().items).toHaveLength(2);
	});

	test("validates entry shape, id, and status", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		expect(() => store.execute(params({ update: "nope" }))).toThrow(/update must be an array/);
		expect(() => store.execute(params({ update: ["nope"] }))).toThrow(/update\[0\] must be an object/);
		expect(() => store.execute(params({ update: [{ status: "pending" }] }))).toThrow(
			/update\[0\]\.id must be a positive integer/,
		);
		expect(() => store.execute(params({ update: [{ id: 1.5 }] }))).toThrow(
			/update\[0\]\.id must be a positive integer/,
		);
		expect(() => store.execute(params({ update: [{ id: 1, status: "urgent" }] }))).toThrow(
			/update\[0\]\.status is invalid/,
		);
		expect(() => store.execute({ update: [{ id: 1, subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1) }] })).toThrow(
			/update\[0\]\.subject exceeds 160 characters/,
		);
		expect(() => store.execute(params({ update: [{ id: 1, owner: "me" }] }))).toThrow(
			/update\[0\]\.owner is not an update field; valid fields: id, subject, description, status/,
		);
		expect(() =>
			store.execute({
				update: Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => ({ id: index + 1 })),
			}),
		).toThrow(/update exceeds 20 tasks/);
	});
});

describe("todo store delete", () => {
	test("removes ids with duplicates ignored and reports the removed subjects", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta", "Gamma", "Delta"]);
		const details = store.execute({ delete: [3, 1, 3, 1] });
		expect(details.change.deleted).toEqual([
			{ id: 3, subject: "Gamma" },
			{ id: 1, subject: "Alpha" },
		]);
		expect(details.change.absent).toEqual([]);
		expect(details.state.items.map((item) => item.id)).toEqual([2, 4]);
		expect(details.state.nextId).toBe(5);
	});

	test("deleting an absent id is a recorded no-op, not an error", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		const details = store.execute({ delete: [1, 9, 2, 9] });
		expect(details.change.deleted).toEqual([
			{ id: 1, subject: "Alpha" },
			{ id: 2, subject: "Beta" },
		]);
		expect(details.change.absent).toEqual([9]);
		expect(details.state.items).toHaveLength(0);

		const again = store.execute({ delete: [1] });
		expect(again.change.deleted).toEqual([]);
		expect(again.change.absent).toEqual([1]);
	});

	test("validates the id list", () => {
		const store = createStore();
		expect(() => store.execute(params({ delete: "nope" }))).toThrow(/delete must be an array/);
		expect(() => store.execute(params({ delete: [1.5] }))).toThrow(/delete\[0\] must be a positive integer id/);
		expect(() =>
			store.execute({ delete: Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => index + 1) }),
		).toThrow(/delete exceeds 20 ids/);
	});

	test("deleting the active task leaves no active task and nextId is never reused", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		store.execute({ update: [{ id: 1, status: "in_progress" }] });
		const details = store.execute({ delete: [1] });
		expect(details.state.items.some((item) => item.status === "in_progress")).toBe(false);
		expect(details.state.nextId).toBe(3);
		createTasks(store, ["Gamma"]);
		expect(task(store.getState(), 3).subject).toBe("Gamma");
	});
});

describe("todo store combined patches", () => {
	test("applies delete before create so a same-call delete frees capacity", () => {
		const store = createStore();
		createTasks(
			store,
			Array.from({ length: TODO_MAX_ITEMS }, (_, index) => `Task ${index + 1}`),
		);
		const details = store.execute({ delete: [1, 2], create: [{ subject: "Fresh", description: "Do it" }] });
		expect(details.change.deleted).toHaveLength(2);
		expect(details.change.created).toEqual([21]);
		expect(details.state.items).toHaveLength(TODO_MAX_ITEMS - 1);
		expect(task(details.state, 21).subject).toBe("Fresh");
	});

	test("one call can complete the active task, start the next, and prune obsolete ids", () => {
		const store = createStore();
		createTasks(store, ["First", "Second", "Third"]);
		store.execute({ update: [{ id: 1, status: "in_progress" }] });
		const details = store.execute({
			update: [
				{ id: 1, status: "completed" },
				{ id: 2, status: "in_progress" },
			],
			delete: [3],
		});
		expect(task(details.state, 1).status).toBe("completed");
		expect(task(details.state, 2).status).toBe("in_progress");
		expect(details.state.items.map((item) => item.id)).toEqual([1, 2]);
		expect(details.change.demotedId).toBeUndefined();
	});

	test("rejects two activations in one call from any combination of groups", () => {
		const store = createStore();
		createTasks(store, ["First", "Second"]);
		expect(() =>
			store.execute({
				update: [
					{ id: 1, status: "in_progress" },
					{ id: 2, status: "in_progress" },
				],
			}),
		).toThrow(/at most one task may be set in_progress per call; got #1 and #2/);
		expect(() =>
			store.execute({
				update: [{ id: 1, status: "in_progress" }],
				create: [{ subject: "New", description: "Do it", status: "in_progress" }],
			}),
		).toThrow(/at most one task may be set in_progress per call; got create\[0\] and #1/);
		expect(() =>
			store.execute({
				create: [
					{ subject: "One", description: "Do it", status: "in_progress" },
					{ subject: "Two", description: "Do it", status: "in_progress" },
				],
			}),
		).toThrow(/at most one task may be set in_progress per call; got create\[0\] and create\[1\]/);
		expect(task(store.getState(), 1).status).toBe("pending");
	});

	test("a create that activates demotes the currently active task", () => {
		const store = createStore();
		createTasks(store, ["First"]);
		store.execute({ update: [{ id: 1, status: "in_progress" }] });
		const details = store.execute({ create: [{ subject: "Urgent", description: "Do it", status: "in_progress" }] });
		expect(details.change.demotedId).toBe(1);
		expect(task(details.state, 1).status).toBe("pending");
		expect(task(details.state, 2).status).toBe("in_progress");
	});

	test("a failed patch leaves the list unchanged", () => {
		const store = createStore();
		createTasks(store, ["Alpha", "Beta"]);
		const before = store.getState();
		expect(() =>
			store.execute({ update: [{ id: 1, status: "completed" }], create: [{ subject: "", description: "d" }] }),
		).toThrow(/create\[0\]\.subject cannot be empty/);
		expect(() => store.execute({ delete: [1], update: [{ id: 99 }] })).toThrow(/#99 not found/);
		expect(store.getState()).toEqual(before);
	});
});

describe("todo store capacity", () => {
	function fullStore(openTasks: number, completedTasks: number): TodoStore {
		const store = createStore();
		if (completedTasks > 0) {
			const created = createTasks(
				store,
				Array.from({ length: completedTasks }, (_, index) => `Done ${index + 1}`),
			);
			store.execute({ update: created.state.items.map((item) => ({ id: item.id, status: "completed" as const })) });
		}
		if (openTasks > 0) {
			createTasks(
				store,
				Array.from({ length: openTasks }, (_, index) => `Open ${index + 1}`),
			);
		}
		return store;
	}

	test("creating past 20 auto-removes the oldest completed tasks and reports them", () => {
		const store = fullStore(18, 2);
		expect(store.getState().items).toHaveLength(20);
		const details = store.execute({ create: [{ subject: "Fresh", description: "Do it" }] });
		expect(details.change.created).toEqual([21]);
		expect(details.change.evicted).toEqual([{ id: 1, subject: "Done 1" }]);
		expect(details.state.items).toHaveLength(20);
		expect(task(details.state, 2).subject).toBe("Done 2");
		expect(task(details.state, 21).subject).toBe("Fresh");
	});

	test("reclaims several completed tasks at once when the batch needs the room", () => {
		const store = fullStore(18, 2);
		const details = store.execute({
			create: [
				{ subject: "One", description: "Do it" },
				{ subject: "Two", description: "Do it" },
			],
		});
		expect(details.change.evicted).toEqual([
			{ id: 1, subject: "Done 1" },
			{ id: 2, subject: "Done 2" },
		]);
		expect(details.state.items).toHaveLength(20);
	});

	test("rejects only when more than 20 tasks would stay open, atomically", () => {
		const store = fullStore(20, 0);
		expect(() => store.execute({ create: [{ subject: "One more", description: "Do it" }] })).toThrow(
			/at most 20 open tasks; complete or delete some first/,
		);
		expect(store.getState().items).toHaveLength(20);

		// One completed task is reclaimed first, so the same create succeeds.
		store.execute({ update: [{ id: 1, status: "completed" }] });
		const details = store.execute({ create: [{ subject: "One more", description: "Do it" }] });
		expect(details.change.evicted).toEqual([{ id: 1, subject: "Open 1" }]);
		expect(details.state.items).toHaveLength(20);
	});
});

describe("todo store list", () => {
	test("{} lists every task without changing state", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const details = store.execute({});
		expect(details.change).toEqual({ created: [], updated: [], deleted: [], absent: [], evicted: [] });
		expect(details.state.items).toEqual(store.getState().items);
	});

	test("empty groups are harmless strict-mode filler and also list", () => {
		const store = createStore();
		createTasks(store, ["Alpha"]);
		const details = store.execute({ create: [], update: [], delete: [] });
		expect(details.change).toEqual({ created: [], updated: [], deleted: [], absent: [], evicted: [] });
		expect(details.state.items).toHaveLength(1);
	});
});

describe("todo details", () => {
	test("carry exactly the v3 shape with no duplicated legacy params", () => {
		const store = createStore();
		const details = createTasks(store, ["Alpha"]);
		expect(details.schemaVersion).toBe(TODO_DETAILS_SCHEMA_VERSION);
		expect(details.schemaVersion).toBe(3);
		expect(Object.keys(details).sort()).toEqual(["change", "schemaVersion", "state"]);
		expect(details.change).toEqual({ created: [1], updated: [], deleted: [], absent: [], evicted: [] });
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

	function v3Details(state: TodoState): unknown {
		return {
			schemaVersion: TODO_DETAILS_SCHEMA_VERSION,
			change: { created: [], updated: [], deleted: [], absent: [], evicted: [] },
			state,
		};
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

	test("replays the newest valid v3 snapshot", () => {
		const older: TodoState = {
			items: [{ id: 1, subject: "Old", description: "Do it", status: "pending" }],
			nextId: 2,
		};
		const newer: TodoState = {
			items: [...older.items, { id: 2, subject: "New", description: "Do it", status: "pending" }],
			nextId: 3,
		};
		const replayed = replayTodosFromBranch(branch([todoResult(v3Details(older)), todoResult(v3Details(newer))]));
		expect(replayed).toEqual(newer);
	});

	test("ignores v1 and v2 snapshots entirely", () => {
		const v1 = {
			schemaVersion: 1,
			action: "list",
			params: {},
			items: [{ id: 1, subject: "Legacy", description: "Do it", status: "pending" }],
			nextId: 2,
		};
		const v2 = { schemaVersion: 2, change: { kind: "list" }, state: validState };
		expect(replayTodosFromBranch(branch([todoResult(v1)]))).toEqual(EMPTY_TODO_STATE);
		expect(replayTodosFromBranch(branch([todoResult(v2)]))).toEqual(EMPTY_TODO_STATE);
	});

	test("falls back past a malformed newest snapshot to the last valid v3", () => {
		const malformed: unknown = {
			schemaVersion: 3,
			change: { created: [], updated: [], deleted: [], absent: [], evicted: [] },
			state: { items: [{ id: 1, subject: "Broken", description: "d", status: "pending" }], nextId: 1 },
		};
		const replayed = replayTodosFromBranch(branch([todoResult(v3Details(validState)), todoResult(malformed)]));
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
				branch([
					todoResult({
						schemaVersion: 3,
						change: { created: [], updated: [], deleted: [], absent: [], evicted: [] },
						state,
					}),
				]),
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

	test("registers the v3 tool schema, prompt, strict sampling, and sequential grouped execution", () => {
		const { tool } = setup();
		expect(tool.name).toBe(TODO_TOOL_NAME);
		expect(tool.label).toBe("Todo");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.toolGroup).toBe(TODO_TOOL_NAME);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(tool.promptSnippet).toContain("task list");
		expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
		// The description carries mechanism only; when-to-use policy lives in the
		// guidelines and per-parameter bounds live in the schema.
		expect(tool.description).toContain("One call applies a patch");
		expect(tool.description).toContain("create adds tasks");
		expect(tool.description).toContain("update edits tasks by id");
		expect(tool.description).toContain("delete removes tasks by id");
		expect(tool.description).toContain("call with {} to list every task");
		expect(tool.description).toContain("oldest completed tasks are removed automatically");
		expect(tool.description).toContain("demotes the others");
		expect(tool.description).not.toMatch(/^##/m);
		expect(tool.promptGuidelines?.every((guideline) => guideline.includes("`todo`"))).toBe(true);
		for (const copy of [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]) {
			expect(copy).not.toMatch(/create_many|blockedBy|addBlocks|metadata|owner|dependency|"action"/);
		}
		expect(Object.keys(tool.parameters.properties).sort()).toEqual(["create", "delete", "update"]);
	});

	test("execute returns v3 details and bounded content, and validation errors do not commit", async () => {
		const { tool } = setup();
		const ctx = {} as unknown as ExtensionContext;
		const created = await tool.execute(
			"call-1",
			{
				create: [
					{ subject: "Wire parser", description: "Parser handles config" },
					{ subject: "Test parser", description: "Parser tests pass" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(created.content).toEqual([{ type: "text", text: "Created 2 tasks: #1: Wire parser; #2: Test parser" }]);
		expect(created.details.schemaVersion).toBe(3);
		expect(created.details.change).toEqual({ created: [1, 2], updated: [], deleted: [], absent: [], evicted: [] });
		expect(created.details.state.items.map((item) => item.id)).toEqual([1, 2]);
		expect(created.details.state.nextId).toBe(3);

		await expect(
			tool.execute("call-2", { update: [{ id: 42, status: "completed" }] }, undefined, undefined, ctx),
		).rejects.toThrow(/#42 not found; current ids: #1, #2/);

		const listed = await tool.execute("call-3", {}, undefined, undefined, ctx);
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
				create: [
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
								schemaVersion: 3,
								change: { created: [], updated: [], deleted: [], absent: [], evicted: [] },
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
			{ create: [{ subject: "Added", description: "Do it" }] },
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
		await tool.execute("call-3", { update: [{ id: 1, status: "completed" }] }, undefined, undefined, branchCtx);
		await tool.execute("call-4", { update: [{ id: 2, status: "completed" }] }, undefined, undefined, branchCtx);
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
