import { afterEach, describe, expect, test } from "vitest";
import {
	type ExtensionAPI,
	type ExtensionContext,
	STALE_EXTENSION_CONTEXT_MESSAGE,
} from "../src/core/extensions/types.ts";
import { LIST_DISPLAY_MAX_ITEMS, TODO_TOOL_NAME } from "../src/extensions/todo/constants.ts";
import todo from "../src/extensions/todo/index.ts";
import { EMPTY_TODO_STATE, type TodoParams, type TodoState } from "../src/extensions/todo/schema.ts";
import {
	applyTodoMutation,
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
		const result = applyTodoMutation(state, { action: "clear" } as TodoParams);
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
