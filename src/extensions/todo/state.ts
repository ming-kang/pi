/**
 * todo/state.ts — v2 pure state core: closure-scoped store, atomic actions,
 * snapshot cloning, and branch replay. No session registry, metadata,
 * dependency graph, tombstones, filters, or legacy normalizers.
 */
import {
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_DESCRIPTION_LENGTH,
	TODO_MAX_ITEMS,
	TODO_MAX_SUBJECT_LENGTH,
	TODO_TOOL_NAME,
} from "./constants.ts";
import {
	EMPTY_TODO_STATE,
	TODO_DETAILS_SCHEMA_VERSION,
	type TodoAction,
	type TodoChange,
	type TodoDetails,
	type TodoItem,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";

const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed"]);
const TODO_ACTIONS: ReadonlySet<TodoAction> = new Set(["create", "update", "list", "delete"]);

/** Parameters each action accepts; anything else is rejected with guidance. */
const ACTION_PARAMS: Record<TodoAction, ReadonlySet<string>> = {
	create: new Set(["items"]),
	update: new Set(["id", "subject", "description", "status"]),
	list: new Set([]),
	delete: new Set(["ids"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.has(value as TodoStatus);
}

function isTodoAction(value: unknown): value is TodoAction {
	return typeof value === "string" && TODO_ACTIONS.has(value as TodoAction);
}

function findItem(state: TodoState, id: number): TodoItem | undefined {
	return state.items.find((item) => item.id === id);
}

/** De-duplicate ids preserving first-seen input order. */
function dedupeIds(ids: number[]): number[] {
	const seen: number[] = [];
	for (const id of ids) {
		if (!seen.includes(id)) seen.push(id);
	}
	return seen;
}

/** Trim and collapse every internal whitespace run to a single space. */
function normalizeText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function validateNormalizedText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const normalized = normalizeText(value);
	if (!normalized) throw new Error(`${label} cannot be empty`);
	if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return normalized;
}

function findInapplicableParam(params: TodoParams): string | undefined {
	const allowed = ACTION_PARAMS[params.action];
	for (const [key, value] of Object.entries(params)) {
		if (key === "action" || value === undefined) continue;
		if (!allowed.has(key)) return `${key} does not apply to action ${params.action}`;
	}
	return undefined;
}

/** Snapshot clone: items are plain string/number records, so a shallow copy is safe. */
export function cloneTodoState(state: TodoState): TodoState {
	return { items: state.items.map((item) => ({ ...item })), nextId: state.nextId };
}

function applyCreate(state: TodoState, params: TodoParams): TodoState {
	const rawItems = params.items;
	if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error("items required for create");
	if (rawItems.length > TODO_MAX_BATCH_ITEMS) throw new Error(`items exceeds ${TODO_MAX_BATCH_ITEMS} tasks`);
	if (state.items.length + rawItems.length > TODO_MAX_ITEMS) {
		throw new Error(`todo list is full (max ${TODO_MAX_ITEMS} tasks); delete completed or obsolete tasks first`);
	}
	if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) throw new Error("next id is invalid");
	if (state.nextId > Number.MAX_SAFE_INTEGER - rawItems.length) throw new Error("next id is exhausted");

	const sources: Array<{ subject: string; description: string }> = [];
	for (let index = 0; index < rawItems.length; index++) {
		const raw = rawItems[index];
		if (!isRecord(raw)) throw new Error(`items[${index}] must be an object`);
		for (const key of Object.keys(raw)) {
			if (key !== "subject" && key !== "description") {
				throw new Error(`items[${index}].${key} does not apply to action create`);
			}
		}
		sources.push({
			subject: validateNormalizedText(raw.subject, `items[${index}].subject`, TODO_MAX_SUBJECT_LENGTH),
			description: validateNormalizedText(
				raw.description,
				`items[${index}].description`,
				TODO_MAX_DESCRIPTION_LENGTH,
			),
		});
	}

	// Atomic: everything above is validated before the new state is built.
	const created = sources.map((source, index) => ({
		id: state.nextId + index,
		subject: source.subject,
		description: source.description,
		status: "pending" as const,
	}));
	return { items: [...state.items, ...created], nextId: state.nextId + created.length };
}

function applyUpdate(state: TodoState, params: TodoParams): TodoState {
	const id = params.id;
	if (!isPositiveSafeInteger(id)) throw new Error("id required for update");
	const index = state.items.findIndex((item) => item.id === id);
	if (index === -1) throw new Error(`#${id} not found`);
	if (params.subject === undefined && params.description === undefined && params.status === undefined) {
		throw new Error("update requires at least one of subject, description, or status");
	}
	const subject =
		params.subject === undefined
			? undefined
			: validateNormalizedText(params.subject, "subject", TODO_MAX_SUBJECT_LENGTH);
	const description =
		params.description === undefined
			? undefined
			: validateNormalizedText(params.description, "description", TODO_MAX_DESCRIPTION_LENGTH);
	if (params.status !== undefined && !isTodoStatus(params.status)) throw new Error("status is invalid");

	const current = state.items[index];
	const updated: TodoItem = {
		id: current.id,
		subject: subject ?? current.subject,
		description: description ?? current.description,
		status: params.status ?? current.status,
	};

	// Exactly one in_progress: setting one demotes every other active task.
	const items = state.items.map((item, itemIndex) => {
		if (itemIndex === index) return updated;
		if (updated.status === "in_progress" && item.status === "in_progress") {
			return { ...item, status: "pending" as const };
		}
		return item;
	});
	return { items, nextId: state.nextId };
}

function applyDelete(state: TodoState, params: TodoParams): TodoState {
	const rawIds = params.ids;
	if (!Array.isArray(rawIds) || rawIds.length === 0) throw new Error("ids required for delete");
	if (rawIds.length > TODO_MAX_BATCH_ITEMS) throw new Error(`ids exceeds ${TODO_MAX_BATCH_ITEMS} ids`);
	const ids: number[] = [];
	for (const raw of rawIds) {
		if (!isPositiveSafeInteger(raw)) throw new Error("ids must contain positive integer ids");
		ids.push(raw);
	}
	const idsToRemove = dedupeIds(ids);
	// Atomic: every id must exist before anything is removed.
	const byId = new Map(state.items.map((item) => [item.id, item]));
	for (const candidate of idsToRemove) {
		if (!byId.has(candidate)) throw new Error(`#${candidate} not found`);
	}
	const remove = new Set(idsToRemove);
	return { items: state.items.filter((item) => !remove.has(item.id)), nextId: state.nextId };
}

/**
 * Pure action application: validates every runtime input and inapplicable
 * parameter (tool args can be tampered after schema validation), throws on
 * any invalid call, and never mutates the input state.
 */
export function applyTodoAction(state: TodoState, params: TodoParams): TodoState {
	if (!isRecord(params)) throw new Error("todo params must be an object");
	if (!isTodoAction(params.action)) throw new Error(`unknown todo action: ${String(params.action)}`);
	const inapplicable = findInapplicableParam(params);
	if (inapplicable) throw new Error(inapplicable);
	switch (params.action) {
		case "create":
			return applyCreate(state, params);
		case "update":
			return applyUpdate(state, params);
		case "list":
			return cloneTodoState(state);
		case "delete":
			return applyDelete(state, params);
	}
}

/** Derive the operation model for one call from the before/after states. */
export function buildTodoChange(params: TodoParams, before: TodoState, after: TodoState): TodoChange {
	switch (params.action) {
		// Derived from the validated before/after states rather than params.items,
		// which is external input and could read differently on a second access.
		case "create":
			return { kind: "create", ids: after.items.slice(before.items.length).map((item) => item.id) };
		case "update": {
			const id = params.id;
			if (!isPositiveSafeInteger(id)) throw new Error("id required for update");
			const demotedId = before.items.find(
				(item) => item.id !== id && item.status === "in_progress" && findItem(after, item.id)?.status === "pending",
			)?.id;
			return {
				kind: "update",
				id,
				from: findItem(before, id)?.status ?? "pending",
				to: findItem(after, id)?.status ?? "pending",
				...(demotedId !== undefined ? { demotedId } : {}),
			};
		}
		case "list":
			return { kind: "list" };
		case "delete": {
			const ids = Array.isArray(params.ids) ? dedupeIds(params.ids) : [];
			const removed = ids
				.map((id) => findItem(before, id))
				.filter((item): item is TodoItem => item !== undefined)
				.map((item) => ({ id: item.id, subject: item.subject }));
			return { kind: "delete", removed };
		}
	}
}

export function buildTodoDetails(change: TodoChange, state: TodoState): TodoDetails {
	return { schemaVersion: TODO_DETAILS_SCHEMA_VERSION, change, state: cloneTodoState(state) };
}

export interface TodoStore {
	getState(): TodoState;
	replaceState(state: TodoState): void;
	execute(params: TodoParams): TodoDetails;
}

function requireValidState(value: unknown): TodoState {
	const state = normalizeSnapshotState(value);
	if (!state) throw new Error("todo state is invalid");
	return state;
}

/** Closure-scoped store: one list per store, no module-global session state. */
export function createTodoStore(initial?: TodoState): TodoStore {
	let state = requireValidState(initial ?? EMPTY_TODO_STATE);
	return {
		getState() {
			return cloneTodoState(state);
		},
		replaceState(next: TodoState) {
			state = requireValidState(next);
		},
		execute(params: TodoParams): TodoDetails {
			const before = state;
			const after = applyTodoAction(before, params);
			const details = buildTodoDetails(buildTodoChange(params, before, after), after);
			state = after;
			return details;
		},
	};
}

/**
 * Validate an external v2 snapshot; returns undefined when malformed.
 *
 * Snapshot text must already be in normalizeText() form, which makes that
 * function's output part of the v2 persistence contract: relaxing or changing
 * it would silently invalidate every historical snapshot, falling back to an
 * earlier one or to the empty state with no diagnostic. Change normalizeText
 * only together with TODO_DETAILS_SCHEMA_VERSION.
 */
function normalizeSnapshotState(value: unknown): TodoState | undefined {
	if (!isRecord(value) || !Array.isArray(value.items) || !isPositiveSafeInteger(value.nextId)) return undefined;
	if (value.items.length > TODO_MAX_ITEMS) return undefined;
	const items: TodoItem[] = [];
	const ids = new Set<number>();
	let maxId = 0;
	let activeCount = 0;
	for (const rawItem of value.items) {
		if (!isRecord(rawItem)) return undefined;
		const id = rawItem.id;
		if (!isPositiveSafeInteger(id) || ids.has(id)) return undefined;
		const subject = rawItem.subject;
		const description = rawItem.description;
		const status = rawItem.status;
		if (typeof subject !== "string" || typeof description !== "string") return undefined;
		if (subject !== normalizeText(subject) || description !== normalizeText(description)) return undefined;
		if (!subject || subject.length > TODO_MAX_SUBJECT_LENGTH) return undefined;
		if (!description || description.length > TODO_MAX_DESCRIPTION_LENGTH) return undefined;
		if (!isTodoStatus(status)) return undefined;
		ids.add(id);
		if (id > maxId) maxId = id;
		if (status === "in_progress") activeCount++;
		items.push({ id, subject, description, status });
	}
	if (activeCount > 1) return undefined;
	if (value.nextId <= maxId) return undefined;
	return { items, nextId: value.nextId };
}

/**
 * Replay the newest valid v2 todo snapshot from a branch, scanning tail to
 * head so a malformed latest snapshot falls back to an earlier valid one.
 * v1 details are ignored, and the `change` field is not validated.
 */
export function replayTodosFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
	const branch = Array.from(ctx.sessionManager.getBranch());
	for (let index = branch.length - 1; index >= 0; index--) {
		// Session history is external input, so every field read stays inside the
		// guard: a hostile entry falls through to an earlier snapshot instead of
		// escaping to the lifecycle handler.
		try {
			const entry = branch[index];
			if (!isRecord(entry) || entry.type !== "message") continue;
			const message = entry.message;
			if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
			const details = message.details;
			if (!isRecord(details) || details.schemaVersion !== TODO_DETAILS_SCHEMA_VERSION) continue;
			const state = normalizeSnapshotState(details.state);
			if (state) return state;
		} catch {
			// Keep scanning for an earlier valid v2 snapshot.
		}
	}
	return cloneTodoState(EMPTY_TODO_STATE);
}
