/**
 * todo/state.ts — v3 pure state core: closure-scoped store, atomic patch
 * application (delete, then update, then create), snapshot cloning, and
 * branch replay. No session registry, metadata, dependency graph, tombstones,
 * filters, or legacy normalizers.
 *
 * The patch shape is designed so every value a strict sampler may fill in for
 * an unused field ([], "", null already stripped by validation) is a no-op:
 * empty groups do nothing, blank update text keeps the current value, and
 * deleting an absent id is recorded rather than rejected.
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
	type TodoChange,
	type TodoDetails,
	type TodoItem,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";

const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed"]);
const GROUP_FIELDS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.has(value as TodoStatus);
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

/** Required text (create): normalized, non-empty, within the limit. */
function validateRequiredText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const normalized = normalizeText(value);
	if (!normalized) throw new Error(`${label} cannot be empty`);
	if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return normalized;
}

/**
 * Optional text (update): normalized and within the limit, where blank means
 * "keep the current value" (undefined) so strict-mode filler stays harmless.
 */
function validateOptionalText(value: unknown, label: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const normalized = normalizeText(value);
	if (!normalized) return undefined;
	if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return normalized;
}

function validateOptionalStatus(value: unknown, label: string): TodoStatus | undefined {
	if (value === undefined) return undefined;
	if (!isTodoStatus(value)) throw new Error(`${label} is invalid`);
	return value;
}

interface CreateEntry {
	subject: string;
	description: string;
	status?: TodoStatus;
}

interface UpdateEntry {
	id: number;
	subject?: string;
	description?: string;
	status?: TodoStatus;
}

function readCreateEntries(raw: unknown): CreateEntry[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error("create must be an array");
	if (raw.length > TODO_MAX_BATCH_ITEMS) throw new Error(`create exceeds ${TODO_MAX_BATCH_ITEMS} tasks`);
	const entries: CreateEntry[] = [];
	for (let index = 0; index < raw.length; index++) {
		const item = raw[index];
		if (!isRecord(item)) throw new Error(`create[${index}] must be an object`);
		for (const key of Object.keys(item)) {
			if (key !== "subject" && key !== "description" && key !== "status") {
				throw new Error(
					`create[${index}].${key} is not a create field; valid fields: subject, description, status`,
				);
			}
		}
		const entry: CreateEntry = {
			subject: validateRequiredText(item.subject, `create[${index}].subject`, TODO_MAX_SUBJECT_LENGTH),
			description: validateRequiredText(
				item.description,
				`create[${index}].description`,
				TODO_MAX_DESCRIPTION_LENGTH,
			),
		};
		const status = validateOptionalStatus(item.status, `create[${index}].status`);
		if (status !== undefined) entry.status = status;
		entries.push(entry);
	}
	return entries;
}

function readUpdateEntries(raw: unknown): UpdateEntry[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error("update must be an array");
	if (raw.length > TODO_MAX_BATCH_ITEMS) throw new Error(`update exceeds ${TODO_MAX_BATCH_ITEMS} tasks`);
	const entries: UpdateEntry[] = [];
	for (let index = 0; index < raw.length; index++) {
		const item = raw[index];
		if (!isRecord(item)) throw new Error(`update[${index}] must be an object`);
		for (const key of Object.keys(item)) {
			if (key !== "id" && key !== "subject" && key !== "description" && key !== "status") {
				throw new Error(
					`update[${index}].${key} is not an update field; valid fields: id, subject, description, status`,
				);
			}
		}
		if (!isPositiveSafeInteger(item.id)) throw new Error(`update[${index}].id must be a positive integer`);
		const entry: UpdateEntry = { id: item.id };
		const subject = validateOptionalText(item.subject, `update[${index}].subject`, TODO_MAX_SUBJECT_LENGTH);
		if (subject !== undefined) entry.subject = subject;
		const description = validateOptionalText(
			item.description,
			`update[${index}].description`,
			TODO_MAX_DESCRIPTION_LENGTH,
		);
		if (description !== undefined) entry.description = description;
		const status = validateOptionalStatus(item.status, `update[${index}].status`);
		if (status !== undefined) entry.status = status;
		entries.push(entry);
	}
	return entries;
}

function readDeleteIds(raw: unknown): number[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error("delete must be an array");
	if (raw.length > TODO_MAX_BATCH_ITEMS) throw new Error(`delete exceeds ${TODO_MAX_BATCH_ITEMS} ids`);
	const ids: number[] = [];
	for (let index = 0; index < raw.length; index++) {
		if (!isPositiveSafeInteger(raw[index])) throw new Error(`delete[${index}] must be a positive integer id`);
		ids.push(raw[index]);
	}
	return ids;
}

function currentIdsLabel(state: TodoState): string {
	if (state.items.length === 0) return "the list is empty";
	return `current ids: ${state.items.map((item) => `#${item.id}`).join(", ")}`;
}

/** Snapshot clone: items are plain string/number records, so a shallow copy is safe. */
export function cloneTodoState(state: TodoState): TodoState {
	return { items: state.items.map((item) => ({ ...item })), nextId: state.nextId };
}

export interface TodoPatch {
	state: TodoState;
	change: TodoChange;
}

/**
 * Pure patch application: validates every runtime input (tool args can be
 * tampered after schema validation), throws on any invalid call, and never
 * mutates the input state. Application order is delete, then update, then
 * create, so a delete in the same call frees capacity for the create.
 */
export function applyTodoPatch(before: TodoState, params: TodoParams): TodoPatch {
	if (!isRecord(params)) throw new Error("todo params must be an object");
	for (const key of Object.keys(params)) {
		if (!GROUP_FIELDS.has(key)) throw new Error(`unknown todo field "${key}"; valid fields: create, update, delete`);
	}

	// Everything above the apply phase is validation: any throw leaves the
	// caller's state untouched.
	const createEntries = readCreateEntries(params.create);
	const updateEntries = readUpdateEntries(params.update);
	const deleteIds = readDeleteIds(params.delete);

	// Conflicts: one edit per task per call, and a task cannot be both edited
	// and removed in the same call.
	const updatedIds = new Set<number>();
	for (const entry of updateEntries) {
		if (updatedIds.has(entry.id)) throw new Error(`#${entry.id} appears more than once in update`);
		updatedIds.add(entry.id);
	}
	const deleteSet = new Set(deleteIds);
	for (const entry of updateEntries) {
		if (deleteSet.has(entry.id)) throw new Error(`#${entry.id} cannot be in both update and delete`);
	}

	// At most one activation per call: more than one is a real contradiction,
	// since a single task can be in_progress at any time.
	const activations: string[] = [];
	createEntries.forEach((entry, index) => {
		if (entry.status === "in_progress") activations.push(`create[${index}]`);
	});
	for (const entry of updateEntries) {
		if (entry.status === "in_progress") activations.push(`#${entry.id}`);
	}
	if (activations.length > 1) {
		throw new Error(`at most one task may be set in_progress per call; got ${activations.join(" and ")}`);
	}

	const byId = new Map(before.items.map((item) => [item.id, item]));
	for (const entry of updateEntries) {
		if (!byId.has(entry.id)) throw new Error(`#${entry.id} not found; ${currentIdsLabel(before)}`);
	}

	if (createEntries.length > 0) {
		if (!Number.isSafeInteger(before.nextId) || before.nextId < 1) throw new Error("next id is invalid");
		if (before.nextId > Number.MAX_SAFE_INTEGER - createEntries.length) throw new Error("next id is exhausted");
	}

	// --- Apply: delete -------------------------------------------------------
	const deleted: Array<{ id: number; subject: string }> = [];
	const absent: number[] = [];
	for (const id of dedupeIds(deleteIds)) {
		const item = byId.get(id);
		if (item) deleted.push({ id: item.id, subject: item.subject });
		else absent.push(id);
	}
	let items = before.items.filter((item) => !deleteSet.has(item.id));

	// --- Apply: update -------------------------------------------------------
	if (updateEntries.length > 0) {
		const entriesById = new Map(updateEntries.map((entry) => [entry.id, entry]));
		items = items.map((item) => {
			const entry = entriesById.get(item.id);
			if (!entry) return item;
			const next: TodoItem = {
				id: item.id,
				subject: entry.subject ?? item.subject,
				description: entry.description ?? item.description,
				status: entry.status ?? item.status,
			};
			return next;
		});
	}

	// --- Apply: create -------------------------------------------------------
	const created: number[] = [];
	if (createEntries.length > 0) {
		const newItems = createEntries.map((entry, index) => {
			const item: TodoItem = {
				id: before.nextId + index,
				subject: entry.subject,
				description: entry.description,
				status: entry.status ?? "pending",
			};
			return item;
		});
		for (const item of newItems) created.push(item.id);
		items = [...items, ...newItems];
	}

	// --- Single in_progress: the one task this call activates demotes the rest.
	let demotedId: number | undefined;
	let activatedId: number | undefined;
	for (const entry of updateEntries) {
		if (entry.status === "in_progress") activatedId = entry.id;
	}
	if (activatedId === undefined) {
		createEntries.forEach((entry, index) => {
			if (entry.status === "in_progress") activatedId = before.nextId + index;
		});
	}
	if (activatedId !== undefined) {
		const demoted = items.find((item) => item.id !== activatedId && item.status === "in_progress");
		if (demoted) {
			demotedId = demoted.id;
			items = items.map((item) => (item.id === demoted.id ? { ...item, status: "pending" as const } : item));
		}
	}

	// --- Capacity: completed tasks are reclaimed oldest-first before a call
	// may fail for space; only a list that stays over the cap is rejected.
	// Tasks this call created or updated are never reclaimed: silently dropping
	// a task would be confusing when the same result reports it as touched.
	const evicted: Array<{ id: number; subject: string }> = [];
	if (items.length > TODO_MAX_ITEMS) {
		let overflow = items.length - TODO_MAX_ITEMS;
		const evictIds = new Set<number>();
		const touched = new Set<number>([...created, ...updatedIds]);
		const completedOldestFirst = items
			.filter((item) => item.status === "completed" && !touched.has(item.id))
			.sort((first, second) => first.id - second.id);
		for (const item of completedOldestFirst) {
			if (overflow <= 0) break;
			evictIds.add(item.id);
			evicted.push({ id: item.id, subject: item.subject });
			overflow--;
		}
		if (overflow > 0) {
			const completedIds = before.items.filter((item) => item.status === "completed").map((item) => `#${item.id}`);
			throw new Error(
				`at most ${TODO_MAX_ITEMS} tasks; complete or delete some first. Patch not applied. Tasks created or updated in this call are not reclaimed. ` +
					`Delete existing tasks in the same patch to free space (remove those ids from update), or complete tasks in a separate call before creating more. ` +
					`Completed ids before this call: ${completedIds.join(", ") || "none"}.`,
			);
		}
		items = items.filter((item) => !evictIds.has(item.id));
	}

	// Report transitions only after activation and capacity have settled the snapshot.
	const updated = items
		.filter((item) => updatedIds.has(item.id))
		.map((item) => ({
			id: item.id,
			from: byId.get(item.id)!.status,
			to: item.status,
		}));
	const change: TodoChange = { created, updated, deleted, absent, evicted };
	if (demotedId !== undefined) change.demotedId = demotedId;
	return { state: { items, nextId: before.nextId + created.length }, change };
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
			const patch = applyTodoPatch(state, params);
			const details = buildTodoDetails(patch.change, patch.state);
			state = patch.state;
			return details;
		},
	};
}

/**
 * Validate an external v3 snapshot; returns undefined when malformed.
 *
 * Snapshot text must already be in normalizeText() form, which makes that
 * function's output part of the v3 persistence contract: relaxing or changing
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
 * Replay the newest valid v3 todo snapshot from a branch, scanning tail to
 * head so a malformed latest snapshot falls back to an earlier valid one.
 * Older schema versions (v1/v2) are ignored: restoring a session written
 * before v3 starts from an empty list.
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
			// Keep scanning for an earlier valid v3 snapshot.
		}
	}
	return cloneTodoState(EMPTY_TODO_STATE);
}
