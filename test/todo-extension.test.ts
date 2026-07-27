import { afterEach, describe, expect, test } from "vitest";
import {
	type ExtensionAPI,
	type ExtensionContext,
	STALE_EXTENSION_CONTEXT_MESSAGE,
} from "../src/core/extensions/types.ts";
import {
	LIST_DISPLAY_MAX_ITEMS,
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_METADATA_BYTES,
	TODO_MAX_METADATA_DEPTH,
	TODO_MAX_METADATA_ENTRIES,
	TODO_MAX_SUBJECT_LENGTH,
	TODO_TOOL_NAME,
} from "../src/extensions/todo/constants.ts";
import todo from "../src/extensions/todo/index.ts";
import { EMPTY_TODO_STATE, type TodoParams, type TodoState } from "../src/extensions/todo/schema.ts";
import {
	applyTodoMutation,
	buildTodoDetails,
	cloneState,
	disposeTodoSession,
	formatTodoContent,
	getTodoState,
	replaceTodoState,
	replayTodosFromBranch,
	setActiveTodoSession,
} from "../src/extensions/todo/state.ts";

function createTask(state: TodoState, subject: string, extra: Partial<TodoParams> = {}): TodoState {
	const result = applyTodoMutation(state, {
		action: "create",
		subject,
		description: `${subject} description`,
		...extra,
	} as TodoParams);
	expect(result.operation.kind).toBe("create");
	return result.state;
}

function update(state: TodoState, id: number, patch: Partial<TodoParams>): ReturnType<typeof applyTodoMutation> {
	return applyTodoMutation(state, { action: "update", id, ...patch } as TodoParams);
}

function expectMutationError(state: TodoState, params: TodoParams, match: string | RegExp): void {
	const result = applyTodoMutation(state, params);
	expect(result.operation.kind).toBe("error");
	if (result.operation.kind === "error") expect(result.operation.message).toMatch(match);
}

function item(state: TodoState, id: number) {
	const found = state.items.find((candidate) => candidate.id === id);
	expect(found).toBeDefined();
	return found as NonNullable<typeof found>;
}

describe("todo create", () => {
	test("assigns sequential ids and starts pending", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Wire the parser");
		state = createTask(state, "Write docs");
		expect(state.items.map((task) => task.id)).toEqual([1, 2]);
		expect(state.items.every((task) => task.status === "pending")).toBe(true);
		expect(state.nextId).toBe(3);
	});

	test("trims the subject", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "  Ship it  ");
		expect(item(state, 1).subject).toBe("Ship it");
	});

	test("rejects a missing subject", () => {
		expectMutationError(cloneState(EMPTY_TODO_STATE), { action: "create" } as TodoParams, /subject required/);
	});

	test("rejects creating in a non-pending status", () => {
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{ action: "create", subject: "Task", description: "d", status: "in_progress" } as TodoParams,
			/starts pending/,
		);
	});

	test("dedupes blockedBy and validates dependency existence", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1, 1] });
		expect(item(state, 2).blockedBy).toEqual([1]);
		expectMutationError(
			state,
			{ action: "create", subject: "Bad", description: "d", blockedBy: [9] } as TodoParams,
			/#9 not found/,
		);
	});

	test("rejects a deleted task as dependency", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams).state;
		expectMutationError(
			state,
			{ action: "create", subject: "Bad", description: "d", blockedBy: [1] } as TodoParams,
			/#1 is deleted/,
		);
	});
});

describe("todo status transitions", () => {
	test("pending -> in_progress -> completed and reopen", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		state = update(state, 1, { status: "in_progress" }).state;
		expect(item(state, 1).status).toBe("in_progress");
		state = update(state, 1, { status: "completed" }).state;
		expect(item(state, 1).status).toBe("completed");
		state = update(state, 1, { status: "in_progress" }).state;
		expect(item(state, 1).status).toBe("in_progress");
	});

	test("deleted tasks cannot be updated", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		state = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams).state;
		expectMutationError(state, { action: "update", id: 1, status: "pending" } as TodoParams, /deleted and cannot/);
	});

	test("marking a task in_progress demotes the previous active task", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "First");
		state = createTask(state, "Second");
		state = update(state, 1, { status: "in_progress" }).state;
		const result = update(state, 2, { status: "in_progress" });
		expect(item(result.state, 1).status).toBe("pending");
		expect(item(result.state, 2).status).toBe("in_progress");
		expect(formatTodoContent(result.operation, result.state)).toContain("#1 demoted to pending");
	});
});

describe("todo update fields", () => {
	test("requires at least one field", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(state, { action: "update", id: 1 } as TodoParams, /at least one field/);
	});

	test("rejects an empty subject", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(state, { action: "update", id: 1, subject: "   " } as TodoParams, /subject cannot be empty/);
	});

	test("merges metadata and deletes null keys", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task", { metadata: { a: 1, b: 2 } });
		state = update(state, 1, { metadata: { b: null, c: 3 } }).state;
		expect(item(state, 1).metadata).toEqual({ a: 1, c: 3 });
		state = update(state, 1, { metadata: { a: null, c: null } }).state;
		expect(item(state, 1).metadata).toBeUndefined();
	});

	test("errors on an unknown id", () => {
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{ action: "update", id: 7, status: "pending" } as TodoParams,
			/#7 not found/,
		);
	});
});

describe("todo dependencies", () => {
	function chain(): TodoState {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		return state;
	}

	test("cannot start or complete a task with incomplete dependencies", () => {
		const state = chain();
		expectMutationError(
			state,
			{ action: "update", id: 2, status: "in_progress" } as TodoParams,
			/complete #1 before/,
		);
		expectMutationError(state, { action: "update", id: 2, status: "completed" } as TodoParams, /complete #1 before/);
	});

	test("completing the dependency unblocks the dependent", () => {
		let state = chain();
		state = update(state, 1, { status: "completed" }).state;
		state = update(state, 2, { status: "in_progress" }).state;
		expect(item(state, 2).status).toBe("in_progress");
	});

	test("rejects self-dependency", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(state, { action: "update", id: 1, addBlockedBy: [1] } as TodoParams, /itself/);
	});

	test("rejects dependency cycles", () => {
		const state = chain();
		expectMutationError(state, { action: "update", id: 1, addBlockedBy: [2] } as TodoParams, /cycle/);
	});

	test("removeBlockedBy drops the edge", () => {
		let state = chain();
		state = update(state, 2, { removeBlockedBy: [1] }).state;
		expect(item(state, 2).blockedBy).toBeUndefined();
	});

	test("delete leaves a tombstone and releases dependents", () => {
		let state = chain();
		state = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams).state;
		expect(item(state, 1).status).toBe("deleted");
		expect(item(state, 2).blockedBy).toBeUndefined();
	});

	test("update to status deleted matches the delete action", () => {
		let state = chain();
		state = update(state, 1, { status: "deleted" }).state;
		expect(item(state, 1).status).toBe("deleted");
		expect(item(state, 2).blockedBy).toBeUndefined();
	});

	test("deleting twice errors", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		state = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams).state;
		expectMutationError(state, { action: "delete", id: 1 } as TodoParams, /already deleted/);
	});
});

describe("todo list, get, clear", () => {
	function sample(): TodoState {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Alpha");
		state = createTask(state, "Beta");
		state = createTask(state, "Gamma");
		state = update(state, 1, { status: "in_progress" }).state;
		state = applyTodoMutation(state, { action: "delete", id: 3 } as TodoParams).state;
		return state;
	}

	function listText(state: TodoState, params: Partial<TodoParams> = {}): string {
		const result = applyTodoMutation(state, { action: "list", ...params } as TodoParams);
		expect(result.operation.kind).toBe("list");
		return formatTodoContent(result.operation, result.state);
	}

	test("list hides tombstones unless asked", () => {
		const state = sample();
		expect(listText(state)).not.toContain("Gamma");
		expect(listText(state, { includeDeleted: true })).toContain("Gamma");
		expect(listText(state, { status: "deleted" })).toContain("Gamma");
	});

	test("list filters by status", () => {
		const state = sample();
		const text = listText(state, { status: "in_progress" });
		expect(text).toContain("Alpha");
		expect(text).not.toContain("Beta");
	});

	test("list output is bounded", () => {
		let state = cloneState(EMPTY_TODO_STATE);
		for (let i = 0; i < LIST_DISPLAY_MAX_ITEMS + 5; i++) {
			state = createTask(state, `Task ${i + 1}`);
		}
		const lines = listText(state).split("\n");
		expect(lines).toHaveLength(LIST_DISPLAY_MAX_ITEMS + 1);
		expect(lines.at(-1)).toContain("more");
	});

	test("get reports both directions of the dependency edge", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		const result = applyTodoMutation(state, { action: "get", id: 1 } as TodoParams);
		expect(formatTodoContent(result.operation, result.state)).toContain("blocks: #2");
	});

	test("clear empties the list but keeps ids monotonic", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		const result = applyTodoMutation(state, { action: "clear", confirm: true, expectedCount: 1 } as TodoParams);
		expect(result.state.items).toHaveLength(0);
		expect(result.state.nextId).toBe(2);
		state = createTask(result.state, "Next");
		expect(item(state, 2).subject).toBe("Next");
	});
});

describe("todo verification nudge", () => {
	function completeAll(subjects: string[]): string {
		let state = cloneState(EMPTY_TODO_STATE);
		for (const subject of subjects) state = createTask(state, subject);
		let lastText = "";
		for (let id = 1; id <= subjects.length; id++) {
			const result = update(state, id, { status: "completed" });
			state = result.state;
			lastText = formatTodoContent(result.operation, result.state);
		}
		return lastText;
	}

	test("nudges when the whole list closes without a verification task", () => {
		expect(completeAll(["Implement parser", "Wire config", "Polish output"])).toContain("NOTE:");
	});

	test("stays silent when a verification-style task completed", () => {
		expect(completeAll(["Implement parser", "Wire config", "Run tests"])).not.toContain("NOTE:");
	});

	test("stays silent for small lists", () => {
		expect(completeAll(["Implement parser", "Wire config"])).not.toContain("NOTE:");
	});
});

describe("todo session buckets", () => {
	afterEach(() => {
		disposeTodoSession("sid-a");
		disposeTodoSession("sid-b");
	});

	test("state is bucketed per session id", () => {
		setActiveTodoSession("sid-a");
		replaceTodoState(createTask(cloneState(EMPTY_TODO_STATE), "A-task"));
		setActiveTodoSession("sid-b");
		expect(getTodoState().items).toHaveLength(0);
		setActiveTodoSession("sid-a");
		expect(getTodoState().items).toHaveLength(1);
	});

	test("dispose drops the bucket", () => {
		setActiveTodoSession("sid-a");
		replaceTodoState(createTask(cloneState(EMPTY_TODO_STATE), "A-task"));
		disposeTodoSession("sid-a");
		setActiveTodoSession("sid-a");
		expect(getTodoState().items).toHaveLength(0);
	});
});

describe("cloneState", () => {
	test("clones items, blockedBy, and metadata deeply", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1], metadata: { key: "value" } });
		const copy = cloneState(state);
		copy.items[1].subject = "Changed";
		copy.items[1].blockedBy?.push(99);
		if (copy.items[1].metadata) copy.items[1].metadata.key = "other";
		expect(item(state, 2).subject).toBe("Dependent");
		expect(item(state, 2).blockedBy).toEqual([1]);
		expect(item(state, 2).metadata).toEqual({ key: "value" });
	});
});

describe("replayTodosFromBranch", () => {
	function todoResultEntry(state: TodoState): unknown {
		return {
			type: "message",
			message: {
				role: "toolResult",
				toolName: TODO_TOOL_NAME,
				details: { action: "list", params: {}, items: state.items, nextId: state.nextId },
			},
		};
	}

	test("returns empty state for an empty branch", () => {
		const replayed = replayTodosFromBranch({ sessionManager: { getBranch: () => [] } });
		expect(replayed).toEqual(EMPTY_TODO_STATE);
	});

	test("latest todo toolResult wins and unrelated entries are skipped", () => {
		const older = createTask(cloneState(EMPTY_TODO_STATE), "Old");
		const newer = createTask(older, "New");
		const branch = [
			todoResultEntry(older),
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: { items: [], nextId: 9 } } },
			todoResultEntry(newer),
			{ type: "custom", customType: "plan-mode" },
		];
		const replayed = replayTodosFromBranch({ sessionManager: { getBranch: () => branch } });
		expect(replayed.items).toHaveLength(2);
		expect(replayed.nextId).toBe(newer.nextId);
	});

	test("malformed details are ignored", () => {
		const branch = [
			{
				type: "message",
				message: { role: "toolResult", toolName: TODO_TOOL_NAME, details: { items: "nope", nextId: "bad" } },
			},
		];
		const replayed = replayTodosFromBranch({ sessionManager: { getBranch: () => branch } });
		expect(replayed).toEqual(EMPTY_TODO_STATE);
	});
});

describe("todo lifecycle with a stale ctx", () => {
	function captureHandlers(): Map<string, (event: unknown, ctx: unknown) => Promise<void>> {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		todo(pi);
		return handlers;
	}

	test("lifecycle replay swallows stale-ctx errors", async () => {
		const handlers = captureHandlers();
		const staleCtx = {
			hasUI: false,
			get sessionManager(): never {
				throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
			},
		};
		for (const event of ["session_start", "session_compact", "session_tree"]) {
			await expect(handlers.get(event)?.({ type: event }, staleCtx)).resolves.toBeUndefined();
		}
	});

	test("other replay errors still propagate", async () => {
		const handlers = captureHandlers();
		const brokenCtx = {
			hasUI: false,
			sessionManager: {
				getSessionId: () => "sid-broken",
				getBranch: () => {
					throw new Error("boom");
				},
			},
		};
		await expect(handlers.get("session_start")?.({ type: "session_start" }, brokenCtx)).rejects.toThrow("boom");
		disposeTodoSession("sid-broken");
	});
});

describe("todo per-action parameter validation", () => {
	test("update rejects blockedBy with guidance", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(
			state,
			{ action: "update", id: 1, blockedBy: [1] } as TodoParams,
			/create-only; use addBlockedBy/,
		);
	});

	test("create rejects update-only edge params with guidance", () => {
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{ action: "create", subject: "Task", description: "d", addBlockedBy: [1] } as TodoParams,
			/update-only; use blockedBy/,
		);
	});

	test("inapplicable params are rejected instead of ignored", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(
			state,
			{ action: "create", subject: "Task", description: "d", id: 1 } as TodoParams,
			/id does not apply to action create/,
		);
		expectMutationError(state, { action: "clear", includeDeleted: true } as TodoParams, /does not apply/);
		expectMutationError(state, { action: "get", id: 1, status: "pending" } as TodoParams, /does not apply/);
	});

	test("create requires a description", () => {
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{ action: "create", subject: "Task" } as TodoParams,
			/description required for create/,
		);
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{ action: "create", subject: "Task", description: "   " } as TodoParams,
			/description required for create/,
		);
	});

	test("status deleted cannot be combined with other changes", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		expectMutationError(
			state,
			{ action: "update", id: 1, status: "deleted", subject: "New name" } as TodoParams,
			/cannot be combined/,
		);
	});
});

describe("todo reverse dependency edges", () => {
	test("addBlocks adds the edge on the target", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent");
		state = update(state, 1, { addBlocks: [2] }).state;
		expect(item(state, 2).blockedBy).toEqual([1]);
	});

	test("addBlocks alone counts as a change", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent");
		const result = update(state, 1, { addBlocks: [2] });
		expect(result.operation.kind).toBe("update");
	});

	test("addBlocks validates the target", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		expectMutationError(state, { action: "update", id: 1, addBlocks: [1] } as TodoParams, /itself/);
		expectMutationError(state, { action: "update", id: 1, addBlocks: [9] } as TodoParams, /#9 not found/);
		state = createTask(state, "Doomed");
		state = applyTodoMutation(state, { action: "delete", id: 2 } as TodoParams).state;
		expectMutationError(state, { action: "update", id: 1, addBlocks: [2] } as TodoParams, /#2 is deleted/);
	});

	test("addBlocks rejects cycles through existing edges", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		expectMutationError(state, { action: "update", id: 2, addBlocks: [1] } as TodoParams, /cycle/);
	});

	test("removeBlocks releases the dependent", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		state = update(state, 1, { removeBlocks: [2] }).state;
		expect(item(state, 2).blockedBy).toBeUndefined();
	});
});

describe("todo delete release notes", () => {
	test("delete reports fully unblocked dependents", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		const result = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams);
		expect(formatTodoContent(result.operation, result.state)).toContain("released #2");
	});

	test("update to status deleted reports releases too", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Dependent", { blockedBy: [1] });
		const result = update(state, 1, { status: "deleted" });
		expect(formatTodoContent(result.operation, result.state)).toContain("released #2");
	});

	test("still-blocked dependents are not reported as released", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Other base");
		state = createTask(state, "Dependent", { blockedBy: [1, 2] });
		const result = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams);
		expect(formatTodoContent(result.operation, result.state)).not.toContain("released");
	});
});

describe("todo optional field clearing", () => {
	test("empty string removes owner, activeForm, and description", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task", {
			owner: "agent-a",
			activeForm: "working",
		});
		state = update(state, 1, { owner: "", activeForm: "", description: "" }).state;
		const task = item(state, 1);
		expect(task.owner).toBeUndefined();
		expect(task.activeForm).toBeUndefined();
		expect(task.description).toBeUndefined();
	});
});

describe("todo list output", () => {
	function listText(state: TodoState, params: Partial<TodoParams> = {}): string {
		const result = applyTodoMutation(state, { action: "list", ...params } as TodoParams);
		return formatTodoContent(result.operation, result.state);
	}

	test("shows only unresolved dependencies and the owner", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Base");
		state = createTask(state, "Blocked", { blockedBy: [1] });
		state = createTask(state, "Owned", { owner: "agent-a" });
		expect(listText(state)).toContain("blockedBy=#1");
		expect(listText(state)).toContain("@agent-a");
		state = update(state, 1, { status: "completed" }).state;
		expect(listText(state)).not.toContain("blockedBy");
	});

	test("truncation hint does not repeat an active status filter", () => {
		let state = cloneState(EMPTY_TODO_STATE);
		for (let i = 0; i < LIST_DISPLAY_MAX_ITEMS + 5; i++) {
			state = createTask(state, `Task ${i + 1}`);
		}
		const filtered = listText(state, { status: "pending" }).split("\n").at(-1) ?? "";
		expect(filtered).toContain("use get with id=");
		expect(filtered).not.toContain("status=");
		const unfiltered = listText(state).split("\n").at(-1) ?? "";
		expect(unfiltered).toContain("narrow with status=");
	});
});

describe("getTodoState isolation", () => {
	afterEach(() => {
		disposeTodoSession("sid-clone");
	});

	test("returns a defensive clone of the stored state", () => {
		setActiveTodoSession("sid-clone");
		replaceTodoState(createTask(cloneState(EMPTY_TODO_STATE), "Task"));
		const first = getTodoState();
		first.items[0].subject = "Tampered";
		first.items.push({ id: 99, subject: "Injected", status: "pending" });
		expect(getTodoState().items).toHaveLength(1);
		expect(getTodoState().items[0].subject).toBe("Task");
	});
});

describe("todo create_many", () => {
	test("creates a dependency-linked batch atomically in input order", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Existing prerequisite");
		const result = applyTodoMutation(state, {
			action: "create_many",
			items: [
				{
					key: "implementation",
					subject: "Implement batch support",
					description: "The batch is persisted in input order",
					blockedBy: [1],
					owner: "agent-a",
					metadata: { nested: { source: "batch" } },
				},
				{
					key: "tests",
					subject: "Test batch support",
					description: "The new behavior is covered",
					blockedByKeys: ["implementation"],
				},
			],
		} as TodoParams);
		expect(result.operation.kind).toBe("create_many");
		expect(result.state.items.map((task) => task.id)).toEqual([1, 2, 3]);
		expect(item(result.state, 2)).toMatchObject({ status: "pending", owner: "agent-a", blockedBy: [1] });
		expect(item(result.state, 3).blockedBy).toEqual([2]);
		expect(result.state.nextId).toBe(4);
	});

	test("rejects invalid batches without changing state", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Existing");
		state = applyTodoMutation(state, { action: "delete", id: 1 } as TodoParams).state;
		const invalidBatches: TodoParams[] = [
			{
				action: "create_many",
				items: [
					{ key: "same", subject: "First", description: "First description" },
					{ key: "same", subject: "Second", description: "Second description" },
				],
			},
			{
				action: "create_many",
				items: [{ subject: "Missing key", description: "No batch key exists", blockedByKeys: ["absent"] }],
			},
			{
				action: "create_many",
				items: [{ subject: "Deleted dependency", description: "Must fail", blockedBy: [1] }],
			},
			{
				action: "create_many",
				items: [
					{ key: "a", subject: "A", description: "A description", blockedByKeys: ["b"] },
					{ key: "b", subject: "B", description: "B description", blockedByKeys: ["a"] },
				],
			},
		];
		for (const params of invalidBatches) {
			const result = applyTodoMutation(state, params);
			expect(result.operation.kind).toBe("error");
			expect(result.state).toEqual(state);
		}
	});

	test("enforces batch count and task text limits before writing", () => {
		const tooMany = Array.from({ length: TODO_MAX_BATCH_ITEMS + 1 }, (_, index) => ({
			subject: `Task ${index}`,
			description: "A valid description",
		}));
		const state = cloneState(EMPTY_TODO_STATE);
		expectMutationError(state, { action: "create_many", items: tooMany } as TodoParams, /exceeds/);
		expectMutationError(
			state,
			{
				action: "create_many",
				items: [{ subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1), description: "A valid description" }],
			} as TodoParams,
			/subject exceeds/,
		);
	});
});

describe("todo bounded metadata", () => {
	test("deeply clones valid metadata and rejects invalid JSON-like values", () => {
		const metadata: Record<string, unknown> = { nested: { value: "original" } };
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Metadata task", { metadata });
		(metadata.nested as { value: string }).value = "mutated input";
		expect((item(state, 1).metadata?.nested as { value: string }).value).toBe("original");
		const copied = cloneState(state);
		(copied.items[0].metadata?.nested as { value: string }).value = "mutated clone";
		expect((item(state, 1).metadata?.nested as { value: string }).value).toBe("original");

		const protoMetadata = JSON.parse('{"__proto__":"created"}') as Record<string, unknown>;
		let protoState = createTask(cloneState(EMPTY_TODO_STATE), "Prototype key", { metadata: protoMetadata });
		expect(Object.hasOwn(item(protoState, 1).metadata ?? {}, "__proto__")).toBe(true);
		expect(item(protoState, 1).metadata?.__proto__).toBe("created");
		const protoPatch = JSON.parse('{"__proto__":{"nested":true}}') as Record<string, unknown>;
		const protoResult = update(protoState, 1, { metadata: protoPatch });
		expect(protoResult.operation.kind).toBe("update");
		protoState = protoResult.state;
		expect(Object.hasOwn(item(protoState, 1).metadata ?? {}, "__proto__")).toBe(true);
		expect(item(protoState, 1).metadata?.__proto__).toEqual({ nested: true });

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const invalid of [{ nonFinite: Infinity }, { callback: () => undefined }, cyclic]) {
			const result = applyTodoMutation(state, { action: "update", id: 1, metadata: invalid } as TodoParams);
			expect(result.operation.kind).toBe("error");
			expect(result.state).toEqual(state);
		}
	});

	test("enforces metadata depth, entry, and byte bounds on create and update", () => {
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let index = 0; index < TODO_MAX_METADATA_DEPTH; index++) {
			const child: Record<string, unknown> = {};
			cursor.child = child;
			cursor = child;
		}
		expectMutationError(
			cloneState(EMPTY_TODO_STATE),
			{
				action: "create",
				subject: "Too deep",
				description: "Metadata cannot be too deep",
				metadata: deep,
			} as TodoParams,
			/depth/,
		);
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		const result = update(state, 1, { metadata: { payload: "x".repeat(TODO_MAX_METADATA_BYTES + 1) } });
		expect(result.operation.kind).toBe("error");
		expect(result.state).toEqual(state);
		expectMutationError(
			state,
			{
				action: "update",
				id: 1,
				metadata: { entries: Array.from({ length: TODO_MAX_METADATA_ENTRIES }, () => 0) },
			} as TodoParams,
			/entries/,
		);
		state = createTask(state, "Bounded text");
		expectMutationError(
			state,
			{ action: "update", id: 2, subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1) } as TodoParams,
			/subject exceeds/,
		);
	});
});

describe("todo list pagination and filters", () => {
	function list(state: TodoState, params: Partial<TodoParams>): string {
		const result = applyTodoMutation(state, { action: "list", ...params } as TodoParams);
		expect(result.operation.kind).toBe("list");
		return formatTodoContent(result.operation, result.state);
	}

	test("applies limit, afterId, query, and unblockedOnly without changing legacy defaults", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Foundation");
		state = createTask(state, "Alpha subject", { description: "Includes a Needle in the description" });
		state = createTask(state, "Beta subject");
		state = createTask(state, "Blocked task", { blockedBy: [1] });

		const firstPage = list(state, { limit: 1 });
		expect(firstPage).toContain("#1 Foundation");
		expect(firstPage).toContain("next page: afterId=1");
		expect(list(state, { afterId: 1, limit: 2 })).toContain("#2 Alpha subject");
		expect(list(state, { query: "needle" })).toContain("Alpha subject");
		expect(list(state, { query: "needle" })).not.toContain("Beta subject");
		const unblocked = list(state, { unblockedOnly: true });
		expect(unblocked).not.toContain("Blocked task");
		expect(list(state, {})).toContain("Blocked task");
		const unordered: TodoState = {
			items: [
				{ id: 100, subject: "Last inserted", status: "pending" },
				{ id: 1, subject: "First", status: "pending" },
				{ id: 2, subject: "Second", status: "pending" },
			],
			nextId: 101,
		};
		const unorderedFirst = list(unordered, { limit: 1 });
		expect(unorderedFirst).toContain("#1 First");
		expect(unorderedFirst).toContain("next page: afterId=1");
		expect(list(unordered, { limit: 1, afterId: 1 })).toContain("#2 Second");
		expectMutationError(state, { action: "list", limit: 0 } as TodoParams, /limit must/);
	});
});

describe("todo clear confirmation", () => {
	test("requires an explicit matching confirmation and leaves state unchanged otherwise", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		for (const params of [
			{ action: "clear" },
			{ action: "clear", confirm: false, expectedCount: 1 },
			{ action: "clear", confirm: true, expectedCount: 0 },
		]) {
			const result = applyTodoMutation(state, params as TodoParams);
			expect(result.operation.kind).toBe("error");
			expect(result.state).toEqual(state);
		}
	});
});

describe("todo dependency demotions", () => {
	test("demotes an active task that gains an incomplete dependency through either edge direction", () => {
		let state = createTask(cloneState(EMPTY_TODO_STATE), "Blocker");
		state = createTask(state, "Active task");
		state = update(state, 2, { status: "in_progress" }).state;
		const direct = update(state, 2, { addBlockedBy: [1] });
		expect(item(direct.state, 2).status).toBe("pending");
		if (direct.operation.kind === "update") expect(direct.operation.blockedIds).toEqual([2]);
		expect(formatTodoContent(direct.operation, direct.state)).toContain("#2 moved to pending");

		state = createTask(cloneState(EMPTY_TODO_STATE), "Blocker");
		state = createTask(state, "Active task");
		state = update(state, 2, { status: "in_progress" }).state;
		const reverse = update(state, 1, { addBlocks: [2] });
		expect(item(reverse.state, 2).status).toBe("pending");
		if (reverse.operation.kind === "update") expect(reverse.operation.blockedIds).toEqual([2]);
	});
});

describe("todo snapshot versioning and defensive replay", () => {
	function entry(details: unknown): unknown {
		return { type: "message", message: { role: "toolResult", toolName: TODO_TOOL_NAME, details } };
	}

	test("writes versioned typed operation details", () => {
		const state = createTask(cloneState(EMPTY_TODO_STATE), "Task");
		const details = buildTodoDetails({ action: "list", limit: 1 } as TodoParams, state);
		expect(details.schemaVersion).toBe(1);
		expect(details.operation).toMatchObject({
			kind: "list",
			limit: 1,
			includeDeleted: false,
			resultCount: 1,
			statusCounts: { pending: 1 },
		});
	});

	test("falls back past malformed latest details and accepts oversized legacy snapshots", () => {
		const older = createTask(cloneState(EMPTY_TODO_STATE), "Older task");
		const validCurrent = buildTodoDetails({ action: "list" } as TodoParams, older);
		const malformedLatest = { ...validCurrent, nextId: 1 };
		const replayed = replayTodosFromBranch({
			sessionManager: { getBranch: () => [entry(validCurrent), entry(malformedLatest)] },
		});
		expect(replayed.items.map((task) => task.subject)).toEqual(["Older task"]);

		const legacy = {
			action: "list",
			params: {},
			items: [
				{
					id: 1,
					subject: "x".repeat(TODO_MAX_SUBJECT_LENGTH + 1),
					description: "Legacy text remains replayable",
					status: "pending",
					unknown: "drop this",
				},
			],
			nextId: 2,
		};
		const legacyReplayed = replayTodosFromBranch({ sessionManager: { getBranch: () => [entry(legacy)] } });
		expect(legacyReplayed.items[0].subject).toHaveLength(TODO_MAX_SUBJECT_LENGTH + 1);
		expect((legacyReplayed.items[0] as unknown as Record<string, unknown>).unknown).toBeUndefined();
	});

	test("normalizes legacy active-but-blocked states and canonicalizes task order", () => {
		const legacy = {
			action: "list",
			params: {},
			items: [
				{ id: 2, subject: "Active dependent", status: "in_progress", blockedBy: [1] },
				{ id: 1, subject: "Incomplete prerequisite", status: "pending" },
			],
			nextId: 3,
		};
		const replayed = replayTodosFromBranch({ sessionManager: { getBranch: () => [entry(legacy)] } });
		expect(replayed.items.map((task) => task.id)).toEqual([1, 2]);
		expect(item(replayed, 2).status).toBe("pending");
	});

	test("replays a deep acyclic dependency chain without recursive traversal", () => {
		const count = 12_000;
		const items = Array.from({ length: count }, (_, index) => ({
			id: index + 1,
			subject: `Task ${index + 1}`,
			status: "pending" as const,
			...(index > 0 ? { blockedBy: [index] } : {}),
		}));
		const replayed = replayTodosFromBranch({
			sessionManager: { getBranch: () => [entry({ action: "list", params: {}, items, nextId: count + 1 })] },
		});
		expect(replayed.items).toHaveLength(count);
		expect(item(replayed, count).blockedBy).toEqual([count - 1]);
	});

	test("rejects malformed graph and state invariants during replay", () => {
		const validItem = { id: 1, subject: "Task", status: "pending" };
		const invalidSnapshots = [
			{ items: [validItem, validItem], nextId: 2 },
			{ items: [{ ...validItem, status: "unknown" }], nextId: 2 },
			{ items: [validItem], nextId: 1 },
			{
				items: [
					{ id: 1, subject: "A", status: "in_progress" },
					{ id: 2, subject: "B", status: "in_progress" },
				],
				nextId: 3,
			},
			{ items: [{ ...validItem, blockedBy: [9] }], nextId: 2 },
			{
				items: [
					{ id: 1, subject: "Deleted", status: "deleted" },
					{ id: 2, subject: "Dependent", status: "pending", blockedBy: [1] },
				],
				nextId: 3,
			},
			{
				items: [
					{ id: 1, subject: "A", status: "pending", blockedBy: [2] },
					{ id: 2, subject: "B", status: "pending", blockedBy: [1] },
				],
				nextId: 3,
			},
		];
		for (const snapshot of invalidSnapshots) {
			const details = { action: "list", params: {}, ...snapshot };
			const replayed = replayTodosFromBranch({ sessionManager: { getBranch: () => [entry(details)] } });
			expect(replayed).toEqual(EMPTY_TODO_STATE);
		}
	});
});

describe("todo tool execute", () => {
	afterEach(() => {
		disposeTodoSession("sid-exec");
	});

	type RegisteredTool = {
		name: string;
		execute: (
			toolCallId: string,
			params: TodoParams,
			signal: undefined,
			onUpdate: undefined,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: { items: unknown[]; nextId: number } }>;
	};

	function registerTodoTool(): RegisteredTool {
		let captured: RegisteredTool | undefined;
		const pi = {
			registerTool: (tool: RegisteredTool) => {
				captured = tool;
			},
			registerCommand: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		todo(pi);
		expect(captured).toBeDefined();
		return captured as RegisteredTool;
	}

	const ctx = { sessionManager: { getSessionId: () => "sid-exec" } } as unknown as ExtensionContext;

	test("create commits state and returns a snapshot in details", async () => {
		const tool = registerTodoTool();
		expect(tool.name).toBe(TODO_TOOL_NAME);
		const result = await tool.execute(
			"call-1",
			{ action: "create", subject: "Ship feature", description: "All of it" } as TodoParams,
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toContain("Created #1");
		expect(result.details.items).toHaveLength(1);
		expect(result.details.nextId).toBe(2);
		setActiveTodoSession("sid-exec");
		expect(getTodoState().items).toHaveLength(1);
	});

	test("errors throw and do not commit state", async () => {
		const tool = registerTodoTool();
		await expect(
			tool.execute(
				"call-2",
				{ action: "update", id: 42, status: "completed" } as TodoParams,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/#42 not found/);
		setActiveTodoSession("sid-exec");
		expect(getTodoState().items).toHaveLength(0);
	});
});
