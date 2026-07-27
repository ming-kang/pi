import {
	LIST_DISPLAY_MAX_ITEMS,
	TODO_MAX_ACTIVE_FORM_LENGTH,
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_BATCH_KEY_LENGTH,
	TODO_MAX_BLOCKED_BY,
	TODO_MAX_DESCRIPTION_LENGTH,
	TODO_MAX_LIST_LIMIT,
	TODO_MAX_LIST_QUERY_LENGTH,
	TODO_MAX_METADATA_BYTES,
	TODO_MAX_METADATA_DEPTH,
	TODO_MAX_METADATA_ENTRIES,
	TODO_MAX_METADATA_KEY_LENGTH,
	TODO_MAX_OWNER_LENGTH,
	TODO_MAX_SUBJECT_LENGTH,
	TODO_TOOL_NAME,
} from "./constants.ts";
import {
	EMPTY_TODO_STATE,
	TODO_DETAILS_SCHEMA_VERSION,
	type TodoAction,
	type TodoDetails,
	type TodoItem,
	type TodoOperationSummary,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";

type Operation =
	| { kind: "create"; id: number }
	| { kind: "create_many"; ids: number[] }
	| {
			kind: "update";
			id: number;
			from: TodoStatus;
			to: TodoStatus;
			/** Other tasks auto-demoted from in_progress → pending to keep exactly one active. */
			demotedIds?: number[];
			/** Active tasks demoted because a new dependency is still incomplete. */
			blockedIds?: number[];
			/** Pending dependents left fully unblocked by an update to status deleted. */
			releasedIds?: number[];
			/** Soft note when the list is fully closed without a verification-style task. */
			verificationNudge?: boolean;
	  }
	| {
			kind: "list";
			status?: TodoStatus;
			includeDeleted: boolean;
			limit: number;
			afterId?: number;
			query?: string;
			unblockedOnly: boolean;
			/** Keep the historical no-options list text stable. */
			legacyOutput: boolean;
	  }
	| { kind: "get"; item: TodoItem }
	| { kind: "delete"; id: number; subject: string; releasedIds?: number[] }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

/** Subjects/descriptions that count as a verification step (CC-style soft nudge). */
const VERIFICATION_PATTERN = /verif|test|check|review/i;
const TODO_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed", "deleted"]);
const TODO_ACTIONS: ReadonlySet<TodoAction> = new Set([
	"create",
	"create_many",
	"update",
	"list",
	"get",
	"delete",
	"clear",
]);
const LEGACY_METADATA_LIMITS = {
	maxDepth: 64,
	maxEntries: 100_000,
	maxBytes: 16 * 1024 * 1024,
};

interface MetadataLimits {
	maxDepth: number;
	maxEntries: number;
	maxBytes: number;
	maxKeyLength?: number;
}

interface MetadataStats {
	entries: number;
	bytes: number;
}

interface ValidMetadata {
	metadata: Record<string, unknown>;
}

interface InvalidMetadata {
	error: string;
}

type MetadataValidation = ValidMetadata | InvalidMetadata;

interface BatchItem {
	key?: string;
	subject: string;
	description: string;
	activeForm?: string;
	blockedBy: number[];
	blockedByKeys: string[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface MutationResult {
	state: TodoState;
	operation: Operation;
}

// ---- per-session state ------------------------------------------------------
// Keyed by session id like rewind's engine state: one Pi process can host more
// than one session over its lifetime (resume, /tree branch switches), and a
// module-level singleton would leak one session's list into another. Tool
// renderers get no ctx, so the active session is a module-level pointer kept
// current by execute and the lifecycle handlers (which do have ctx).
const states = new Map<string, TodoState>();
let activeSid = "";

/** Point the module at a session's state bucket. Call wherever ctx is in hand. */
export function setActiveTodoSession(sid: string): void {
	activeSid = sid;
}

/** Snapshot of the active session's state; mutate via applyTodoMutation + commitTodoState. */
export function getTodoState(): TodoState {
	return cloneState(states.get(activeSid) ?? EMPTY_TODO_STATE);
}

export function replaceTodoState(next: TodoState): void {
	states.set(activeSid, cloneState(next));
}

export function commitTodoState(next: TodoState): void {
	replaceTodoState(next);
}

/** Drop in-memory state for a session (call from session_shutdown). */
export function disposeTodoSession(sid: string): void {
	if (!sid) return;
	states.delete(sid);
	if (activeSid === sid) activeSid = "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.has(value as TodoStatus);
}

function isTodoAction(value: unknown): value is TodoAction {
	return typeof value === "string" && TODO_ACTIONS.has(value as TodoAction);
}

function jsonStringUtf8Bytes(value: string): number {
	let bytes = 2; // JSON quotes
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x0c ||
			code === 0x0a ||
			code === 0x0d ||
			code === 0x09
		) {
			bytes += 2;
			continue;
		}
		if (code <= 0x1f) {
			bytes += 6;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 6; // JSON escapes lone surrogates.
			}
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			bytes += 6;
			continue;
		}
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	}
	return bytes;
}

function addMetadataBytes(stats: MetadataStats, amount: number, limits: MetadataLimits): void {
	stats.bytes += amount;
	if (stats.bytes > limits.maxBytes) throw new Error(`metadata exceeds ${limits.maxBytes} UTF-8 bytes`);
}

function addMetadataEntry(stats: MetadataStats, limits: MetadataLimits): void {
	stats.entries++;
	if (stats.entries > limits.maxEntries) throw new Error(`metadata exceeds ${limits.maxEntries} entries`);
}

/**
 * Validate and clone JSON-like values without using JSON.stringify as the
 * validator. This rejects cycles, accessors, non-finite numbers, functions,
 * symbols, bigint, undefined, and non-plain object instances.
 */
function cloneJsonValue(
	value: unknown,
	depth: number,
	ancestors: WeakSet<object>,
	stats: MetadataStats,
	limits: MetadataLimits,
): unknown {
	if (depth > limits.maxDepth) throw new Error(`metadata exceeds depth ${limits.maxDepth}`);
	if (value === null) {
		addMetadataBytes(stats, 4, limits);
		return null;
	}
	if (typeof value === "string") {
		addMetadataBytes(stats, jsonStringUtf8Bytes(value), limits);
		return value;
	}
	if (typeof value === "boolean") {
		addMetadataBytes(stats, value ? 4 : 5, limits);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("metadata numbers must be finite");
		addMetadataBytes(stats, Buffer.byteLength(String(value), "utf8"), limits);
		return value;
	}
	if (typeof value !== "object") throw new Error("metadata must contain only JSON-like values");
	if (ancestors.has(value)) throw new Error("metadata cannot contain cycles");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > limits.maxEntries - stats.entries) {
				throw new Error(`metadata exceeds ${limits.maxEntries} entries`);
			}
			const ownKeys = Object.keys(value);
			if (ownKeys.length !== value.length)
				throw new Error("metadata arrays cannot be sparse or have extra properties");
			const copy: unknown[] = [];
			addMetadataBytes(stats, 2, limits);
			for (let index = 0; index < value.length; index++) {
				addMetadataEntry(stats, limits);
				if (index > 0) addMetadataBytes(stats, 1, limits);
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor)) throw new Error("metadata cannot contain accessors");
				copy.push(cloneJsonValue(descriptor.value, depth + 1, ancestors, stats, limits));
			}
			return copy;
		}

		if (!isPlainRecord(value)) throw new Error("metadata objects must be plain objects");
		const copy: Record<string, unknown> = {};
		const keys = Object.keys(value);
		if (keys.length > limits.maxEntries - stats.entries) {
			throw new Error(`metadata exceeds ${limits.maxEntries} entries`);
		}
		addMetadataBytes(stats, 2, limits);
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (limits.maxKeyLength !== undefined && key.length > limits.maxKeyLength) {
				throw new Error(`metadata keys exceed ${limits.maxKeyLength} characters`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) throw new Error("metadata cannot contain accessors");
			addMetadataEntry(stats, limits);
			if (index > 0) addMetadataBytes(stats, 1, limits);
			addMetadataBytes(stats, jsonStringUtf8Bytes(key) + 1, limits);
			Object.defineProperty(copy, key, {
				value: cloneJsonValue(descriptor.value, depth + 1, ancestors, stats, limits),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return copy;
	} finally {
		ancestors.delete(value);
	}
}

function validateAndCloneMetadata(value: unknown, limits: MetadataLimits): MetadataValidation {
	if (!isPlainRecord(value)) return { error: "metadata must be a plain object" };
	try {
		const cloned = cloneJsonValue(value, 1, new WeakSet<object>(), { entries: 0, bytes: 0 }, limits);
		if (!isPlainRecord(cloned)) return { error: "metadata must be a plain object" };
		return { metadata: cloned };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "metadata is invalid" };
	}
}

function cloneStoredMetadata(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const result = validateAndCloneMetadata(value, LEGACY_METADATA_LIMITS);
	return "metadata" in result ? result.metadata : undefined;
}

export function cloneState(source: TodoState): TodoState {
	return {
		items: source.items.map((item) => {
			const clone: TodoItem = { ...item };
			if (item.blockedBy) clone.blockedBy = [...item.blockedBy];
			else delete clone.blockedBy;
			if (item.metadata) {
				const metadata = cloneStoredMetadata(item.metadata);
				if (metadata) clone.metadata = metadata;
				else delete clone.metadata;
			} else delete clone.metadata;
			return clone;
		}),
		nextId: source.nextId,
	};
}

function omitBlockedBy(item: TodoItem): TodoItem {
	const next = { ...item };
	delete next.blockedBy;
	return next;
}

/**
 * Keep a tombstone while detaching its id from every dependent task. Also
 * reports which pending dependents ended up fully unblocked, so the tool
 * result can tell the model what became workable (mirrors the demote note).
 */
function markDeleted(state: TodoState, id: number): { state: TodoState; releasedIds: number[] } {
	const items = state.items.map((item) => {
		if (item.id === id) return { ...item, status: "deleted" as const };
		if (!item.blockedBy?.includes(id)) return item;
		const blockedBy = item.blockedBy.filter((dependencyId) => dependencyId !== id);
		return blockedBy.length ? { ...item, blockedBy } : omitBlockedBy(item);
	});
	const nextState: TodoState = { items, nextId: state.nextId };
	const releasedIds = state.items
		.filter((item) => item.id !== id && item.status === "pending" && item.blockedBy?.includes(id))
		.map((item) => item.id)
		.filter((dependentId) => {
			const dependent = findItem(nextState, dependentId);
			return dependent !== undefined && unresolvedDependencyIds(nextState, dependent).length === 0;
		});
	return { state: nextState, releasedIds };
}

function error(state: TodoState, message: string): MutationResult {
	return { state, operation: { kind: "error", message } };
}

// ---- per-action parameter validation ---------------------------------------
// Parameters each action accepts. Anything else is rejected with guidance
// instead of being silently ignored (a model that passes blockedBy on update
// should learn about addBlockedBy, not lose the edit).
const ACTION_PARAMS: Record<TodoAction, ReadonlySet<string>> = {
	create: new Set(["subject", "description", "activeForm", "status", "blockedBy", "owner", "metadata"]),
	create_many: new Set(["items"]),
	update: new Set([
		"id",
		"subject",
		"description",
		"activeForm",
		"status",
		"addBlockedBy",
		"removeBlockedBy",
		"addBlocks",
		"removeBlocks",
		"owner",
		"metadata",
	]),
	list: new Set(["status", "includeDeleted", "limit", "afterId", "query", "unblockedOnly"]),
	get: new Set(["id"]),
	delete: new Set(["id"]),
	clear: new Set(["confirm", "expectedCount"]),
};

const UPDATE_ONLY_EDGE_PARAMS = new Set(["addBlockedBy", "removeBlockedBy", "addBlocks", "removeBlocks"]);

function inapplicableParamError(action: TodoAction, key: string): string {
	if (action === "update" && key === "blockedBy") {
		return "blockedBy is create-only; use addBlockedBy/removeBlockedBy on update";
	}
	if (action === "create" && UPDATE_ONLY_EDGE_PARAMS.has(key)) {
		return `${key} is update-only; use blockedBy on create`;
	}
	return `${key} does not apply to action ${action}`;
}

function findInapplicableParam(params: TodoParams): string | undefined {
	const allowed = ACTION_PARAMS[params.action];
	for (const [key, value] of Object.entries(params)) {
		if (key === "action" || value === undefined) continue;
		if (!allowed.has(key)) return inapplicableParamError(params.action, key);
	}
	return undefined;
}

function validateBoundedString(value: unknown, label: string, maximum: number): string | undefined {
	if (typeof value !== "string") return `${label} must be a string`;
	if (value.length > maximum) return `${label} exceeds ${maximum} characters`;
	return undefined;
}

function validateTaskTextFields(params: TodoParams, requireDescription: boolean): string | undefined {
	if (params.subject !== undefined) {
		const subjectError = validateBoundedString(params.subject, "subject", TODO_MAX_SUBJECT_LENGTH);
		if (subjectError) return subjectError;
	}
	if (params.description !== undefined) {
		const descriptionError = validateBoundedString(params.description, "description", TODO_MAX_DESCRIPTION_LENGTH);
		if (descriptionError) return descriptionError;
	}
	if (params.activeForm !== undefined) {
		const activeFormError = validateBoundedString(params.activeForm, "activeForm", TODO_MAX_ACTIVE_FORM_LENGTH);
		if (activeFormError) return activeFormError;
	}
	if (params.owner !== undefined) {
		const ownerError = validateBoundedString(params.owner, "owner", TODO_MAX_OWNER_LENGTH);
		if (ownerError) return ownerError;
	}
	if (params.subject !== undefined && !params.subject.trim()) return "subject cannot be empty";
	if (requireDescription && !params.description?.trim()) {
		return "description required for create: state what done means for this task";
	}
	return undefined;
}

function validateIdArray(value: unknown, label: string): number[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return `${label} must be an array`;
	if (value.length > TODO_MAX_BLOCKED_BY) return `${label} exceeds ${TODO_MAX_BLOCKED_BY} ids`;
	const ids: number[] = [];
	for (const id of value) {
		if (!isPositiveInteger(id)) return `${label} must contain positive integer ids`;
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

function isTransitionAllowed(from: TodoStatus, to: TodoStatus): boolean {
	// `deleted` is the only terminal status; `completed` can be reopened to
	// in_progress or pending so a premature completion recovers without losing
	// the task id and its blockedBy edges.
	if (from === to) return true;
	if (from === "deleted") return false;
	if (to === "deleted") return true;
	if (to === "completed") return from === "pending" || from === "in_progress";
	if (to === "pending") return from === "in_progress" || from === "completed";
	if (to === "in_progress") return from === "pending" || from === "completed";
	return false;
}

function findItem(state: TodoState, id: number): TodoItem | undefined {
	return state.items.find((item) => item.id === id);
}

function validateDependencies(state: TodoState, deps: number[], currentId?: number): string | undefined {
	for (const dep of deps) {
		if (dep === currentId) return `cannot block #${currentId} on itself`;
		const item = findItem(state, dep);
		if (!item) return `blockedBy: #${dep} not found`;
		if (item.status === "deleted") return `blockedBy: #${dep} is deleted`;
	}
	return undefined;
}

/** All listed dependencies must be completed before starting or closing a task. */
function validateDependenciesReady(state: TodoState, deps: number[]): string | undefined {
	for (const dep of deps) {
		const item = findItem(state, dep);
		if (!item || item.status !== "completed") {
			return `blockedBy: complete #${dep} before starting or finishing this task`;
		}
	}
	return undefined;
}

/** IDs of dependencies that still prevent a task from starting or completing. */
export function unresolvedDependencyIds(state: TodoState, item: TodoItem): number[] {
	return (item.blockedBy ?? []).filter((id) => findItem(state, id)?.status !== "completed");
}

/** True when every blockedBy dependency is completed (for transition and overlay checks). */
export function dependenciesSatisfied(state: TodoState, item: TodoItem): boolean {
	return unresolvedDependencyIds(state, item).length === 0;
}

/** True when the resulting dependency graph contains a cycle. */
function createsCycle(items: TodoItem[], nextDepsById: ReadonlyMap<number, number[]>): boolean {
	const depsById = new Map<number, number[]>();
	for (const item of items) depsById.set(item.id, item.blockedBy ?? []);
	for (const [id, deps] of nextDepsById) depsById.set(id, deps);

	// An iterative color walk keeps replay and dependency edits safe for long,
	// valid chains that would overflow the JavaScript call stack recursively.
	const colors = new Map<number, 0 | 1 | 2>();
	const stack: Array<{ id: number; nextDependencyIndex: number }> = [];
	for (const initialId of depsById.keys()) {
		if ((colors.get(initialId) ?? 0) !== 0) continue;
		colors.set(initialId, 1);
		stack.push({ id: initialId, nextDependencyIndex: 0 });

		while (stack.length) {
			const frame = stack[stack.length - 1]!;
			const dependencies = depsById.get(frame.id) ?? [];
			if (frame.nextDependencyIndex >= dependencies.length) {
				colors.set(frame.id, 2);
				stack.pop();
				continue;
			}

			const dependencyId = dependencies[frame.nextDependencyIndex]!;
			frame.nextDependencyIndex++;
			if (!depsById.has(dependencyId)) continue;
			const color = colors.get(dependencyId) ?? 0;
			if (color === 1) return true;
			if (color === 2) continue;
			colors.set(dependencyId, 1);
			stack.push({ id: dependencyId, nextDependencyIndex: 0 });
		}
	}
	return false;
}

function validateAndNormalizeBatch(params: TodoParams, state: TodoState): BatchItem[] | string {
	const rawItems: unknown = (params as Record<string, unknown>).items;
	if (!Array.isArray(rawItems) || rawItems.length === 0) return "items required for create_many";
	if (rawItems.length > TODO_MAX_BATCH_ITEMS) return `items exceeds ${TODO_MAX_BATCH_ITEMS} tasks`;

	const allowedKeys = new Set([
		"key",
		"subject",
		"description",
		"activeForm",
		"blockedBy",
		"blockedByKeys",
		"owner",
		"metadata",
	]);
	const batch: BatchItem[] = [];
	const keys = new Map<string, number>();
	for (let index = 0; index < rawItems.length; index++) {
		const raw = rawItems[index];
		if (!isPlainRecord(raw)) return `items[${index}] must be an object`;
		for (const property of Object.keys(raw)) {
			if (!allowedKeys.has(property)) return `items[${index}].${property} does not apply to create_many`;
		}
		const taskParams = raw as TodoParams;
		if (typeof raw.subject !== "string" || !raw.subject.trim())
			return `items[${index}]: subject required for create_many`;
		const taskTextError = validateTaskTextFields(taskParams, true);
		if (taskTextError) return `items[${index}]: ${taskTextError}`;

		let key: string | undefined;
		if (raw.key !== undefined) {
			const keyError = validateBoundedString(raw.key, "key", TODO_MAX_BATCH_KEY_LENGTH);
			if (keyError) return `items[${index}]: ${keyError}`;
			key = (raw.key as string).trim();
			if (!key) return `items[${index}]: key cannot be empty`;
			if (keys.has(key)) return `items[${index}]: duplicate key ${key}`;
			keys.set(key, index);
		}

		const blockedBy = validateIdArray(raw.blockedBy, `items[${index}].blockedBy`);
		if (typeof blockedBy === "string") return blockedBy;
		const blockedByError = validateDependencies(state, blockedBy);
		if (blockedByError) return `items[${index}]: ${blockedByError}`;

		const rawBlockedByKeys = raw.blockedByKeys;
		if (rawBlockedByKeys !== undefined && !Array.isArray(rawBlockedByKeys)) {
			return `items[${index}].blockedByKeys must be an array`;
		}
		if (Array.isArray(rawBlockedByKeys) && rawBlockedByKeys.length > TODO_MAX_BLOCKED_BY) {
			return `items[${index}].blockedByKeys exceeds ${TODO_MAX_BLOCKED_BY} keys`;
		}
		const blockedByKeys: string[] = [];
		for (const reference of rawBlockedByKeys ?? []) {
			const referenceError = validateBoundedString(reference, "blockedByKeys", TODO_MAX_BATCH_KEY_LENGTH);
			if (referenceError) return `items[${index}]: ${referenceError}`;
			const normalizedReference = (reference as string).trim();
			if (!normalizedReference) return `items[${index}]: blockedByKeys cannot contain an empty key`;
			if (!blockedByKeys.includes(normalizedReference)) blockedByKeys.push(normalizedReference);
		}

		let metadata: Record<string, unknown> | undefined;
		if (raw.metadata !== undefined) {
			const metadataResult = validateAndCloneMetadata(raw.metadata, {
				maxDepth: TODO_MAX_METADATA_DEPTH,
				maxEntries: TODO_MAX_METADATA_ENTRIES,
				maxBytes: TODO_MAX_METADATA_BYTES,
				maxKeyLength: TODO_MAX_METADATA_KEY_LENGTH,
			});
			if ("error" in metadataResult) return `items[${index}]: ${metadataResult.error}`;
			metadata = metadataResult.metadata;
		}

		batch.push({
			...(key ? { key } : {}),
			subject: (raw.subject as string).trim(),
			description: raw.description as string,
			...(raw.activeForm ? { activeForm: raw.activeForm as string } : {}),
			blockedBy,
			blockedByKeys,
			...(raw.owner ? { owner: raw.owner as string } : {}),
			...(metadata ? { metadata } : {}),
		});
	}

	for (let index = 0; index < batch.length; index++) {
		for (const key of batch[index].blockedByKeys) {
			if (!keys.has(key)) return `items[${index}]: blockedByKeys references missing key ${key}`;
			if (key === batch[index].key) return `items[${index}]: cannot block a task on itself`;
		}
	}
	return batch;
}

function createMany(state: TodoState, params: TodoParams): MutationResult {
	const batch = validateAndNormalizeBatch(params, state);
	if (typeof batch === "string") return error(state, batch);
	if (
		!Number.isSafeInteger(state.nextId) ||
		state.nextId < 1 ||
		state.nextId + batch.length - 1 > Number.MAX_SAFE_INTEGER
	) {
		return error(state, "next id is invalid or exhausted");
	}

	const idsByKey = new Map<string, number>();
	for (let index = 0; index < batch.length; index++) {
		const key = batch[index].key;
		if (key) idsByKey.set(key, state.nextId + index);
	}
	const created = batch.map((source, index) => {
		const blockedBy = [...source.blockedBy];
		for (const key of source.blockedByKeys) {
			const id = idsByKey.get(key);
			if (id !== undefined && !blockedBy.includes(id)) blockedBy.push(id);
		}
		const item: TodoItem = {
			id: state.nextId + index,
			subject: source.subject,
			description: source.description,
			status: "pending",
		};
		if (source.activeForm) item.activeForm = source.activeForm;
		if (blockedBy.length) item.blockedBy = blockedBy;
		if (source.owner) item.owner = source.owner;
		if (source.metadata) item.metadata = source.metadata;
		return item;
	});
	const batchEdges = new Map<number, number[]>();
	for (const item of created) batchEdges.set(item.id, item.blockedBy ?? []);
	if (createsCycle([...state.items, ...created], batchEdges)) return error(state, "blockedBy would create a cycle");

	return {
		state: { items: [...state.items, ...created], nextId: state.nextId + created.length },
		operation: { kind: "create_many", ids: created.map((item) => item.id) },
	};
}

export function applyTodoMutation(input: TodoState, params: TodoParams): MutationResult {
	const state = cloneState(input);
	if (!isTodoAction(params.action)) return error(state, `unknown action: ${String(params.action)}`);

	const inapplicable = findInapplicableParam(params);
	if (inapplicable) return error(state, inapplicable);

	switch (params.action) {
		case "create": {
			if (typeof params.subject !== "string" || !params.subject.trim())
				return error(state, "subject required for create");
			const taskTextError = validateTaskTextFields(params, true);
			if (taskTextError) return error(state, taskTextError);
			if (params.status !== undefined && params.status !== "pending") {
				return error(state, "create always starts pending; use update to start or complete a task");
			}
			const blockedBy = validateIdArray(params.blockedBy, "blockedBy");
			if (typeof blockedBy === "string") return error(state, blockedBy);
			const dependencyError = validateDependencies(state, blockedBy);
			if (dependencyError) return error(state, dependencyError);

			let metadata: Record<string, unknown> | undefined;
			if (params.metadata !== undefined) {
				const metadataResult = validateAndCloneMetadata(params.metadata, {
					maxDepth: TODO_MAX_METADATA_DEPTH,
					maxEntries: TODO_MAX_METADATA_ENTRIES,
					maxBytes: TODO_MAX_METADATA_BYTES,
					maxKeyLength: TODO_MAX_METADATA_KEY_LENGTH,
				});
				if ("error" in metadataResult) return error(state, metadataResult.error);
				metadata = metadataResult.metadata;
			}

			if (!Number.isSafeInteger(state.nextId) || state.nextId < 1 || state.nextId === Number.MAX_SAFE_INTEGER) {
				return error(state, "next id is invalid or exhausted");
			}
			const item: TodoItem = {
				id: state.nextId,
				subject: (params.subject as string).trim(),
				status: "pending",
				description: params.description as string,
			};
			if (params.activeForm) item.activeForm = params.activeForm;
			if (blockedBy.length) item.blockedBy = blockedBy;
			if (params.owner) item.owner = params.owner;
			if (metadata) item.metadata = metadata;

			return {
				state: { items: [...state.items, item], nextId: state.nextId + 1 },
				operation: { kind: "create", id: item.id },
			};
		}

		case "create_many":
			return createMany(state, params);

		case "update": {
			if (!isPositiveInteger(params.id)) return error(state, "id required for update");
			const index = state.items.findIndex((item) => item.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const current = state.items[index];
			if (current.status === "deleted") return error(state, `#${params.id} is deleted and cannot be updated`);
			const taskTextError = validateTaskTextFields(params, false);
			if (taskTextError) return error(state, taskTextError);
			if (params.status !== undefined && !isTodoStatus(params.status)) return error(state, "status is invalid");

			const addBlockedBy = validateIdArray(params.addBlockedBy, "addBlockedBy");
			const removeBlockedBy = validateIdArray(params.removeBlockedBy, "removeBlockedBy");
			const addBlocks = validateIdArray(params.addBlocks, "addBlocks");
			const removeBlocks = validateIdArray(params.removeBlocks, "removeBlocks");
			if (typeof addBlockedBy === "string") return error(state, addBlockedBy);
			if (typeof removeBlockedBy === "string") return error(state, removeBlockedBy);
			if (typeof addBlocks === "string") return error(state, addBlocks);
			if (typeof removeBlocks === "string") return error(state, removeBlocks);
			const edgeChange =
				addBlockedBy.length > 0 || removeBlockedBy.length > 0 || addBlocks.length > 0 || removeBlocks.length > 0;
			const fieldChange =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined;
			if (!fieldChange && !edgeChange && params.status === undefined) {
				return error(state, "update requires at least one field");
			}

			if (params.status === "deleted") {
				if (fieldChange || edgeChange) {
					return error(
						state,
						"status deleted cannot be combined with other changes; apply edits first or delete in a separate call",
					);
				}
				const deleted = markDeleted(state, current.id);
				return {
					state: deleted.state,
					operation: {
						kind: "update",
						id: current.id,
						from: current.status,
						to: "deleted",
						...(deleted.releasedIds.length ? { releasedIds: deleted.releasedIds } : {}),
					},
				};
			}

			const nextStatus = params.status ?? current.status;
			if (!isTransitionAllowed(current.status, nextStatus)) {
				return error(state, `illegal transition ${current.status} -> ${nextStatus}`);
			}

			let metadata: Record<string, unknown> | undefined;
			if (params.metadata !== undefined) {
				const patchResult = validateAndCloneMetadata(params.metadata, {
					maxDepth: TODO_MAX_METADATA_DEPTH,
					maxEntries: TODO_MAX_METADATA_ENTRIES,
					maxBytes: TODO_MAX_METADATA_BYTES,
					maxKeyLength: TODO_MAX_METADATA_KEY_LENGTH,
				});
				if ("error" in patchResult) return error(state, patchResult.error);
				const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
				for (const [key, value] of Object.entries(current.metadata ?? {})) merged[key] = value;
				for (const [key, value] of Object.entries(patchResult.metadata)) {
					if (value === null) delete merged[key];
					else merged[key] = value;
				}
				if (Object.keys(merged).length) {
					const mergedResult = validateAndCloneMetadata(merged, {
						maxDepth: TODO_MAX_METADATA_DEPTH,
						maxEntries: TODO_MAX_METADATA_ENTRIES,
						maxBytes: TODO_MAX_METADATA_BYTES,
						maxKeyLength: TODO_MAX_METADATA_KEY_LENGTH,
					});
					if ("error" in mergedResult) return error(state, mergedResult.error);
					metadata = mergedResult.metadata;
				}
			}

			// Collect every task whose blockedBy changes: this task (addBlockedBy /
			// removeBlockedBy) plus reverse-edge targets (addBlocks / removeBlocks).
			const nextDepsById = new Map<number, number[]>();
			let nextDeps = current.blockedBy ? [...current.blockedBy] : [];
			if (removeBlockedBy.length) {
				const remove = new Set(removeBlockedBy);
				nextDeps = nextDeps.filter((id) => !remove.has(id));
			}
			if (addBlockedBy.length) {
				const dependencyError = validateDependencies(state, addBlockedBy, current.id);
				if (dependencyError) return error(state, dependencyError);
				for (const dep of addBlockedBy) {
					if (!nextDeps.includes(dep)) nextDeps.push(dep);
				}
			}
			nextDepsById.set(current.id, nextDeps);

			if (removeBlocks.length) {
				const release = new Set(removeBlocks);
				for (const candidate of state.items) {
					if (!release.has(candidate.id) || !candidate.blockedBy?.includes(current.id)) continue;
					nextDepsById.set(
						candidate.id,
						candidate.blockedBy.filter((dependencyId) => dependencyId !== current.id),
					);
				}
			}
			if (addBlocks.length) {
				for (const targetId of addBlocks) {
					if (targetId === current.id) return error(state, `cannot block #${targetId} on itself`);
					const target = findItem(state, targetId);
					if (!target) return error(state, `addBlocks: #${targetId} not found`);
					if (target.status === "deleted") return error(state, `addBlocks: #${targetId} is deleted`);
					const deps = nextDepsById.get(targetId) ?? (target.blockedBy ? [...target.blockedBy] : []);
					if (!deps.includes(current.id)) deps.push(current.id);
					nextDepsById.set(targetId, deps);
				}
			}
			if (createsCycle(state.items, nextDepsById)) {
				return error(state, "blockedBy would create a cycle");
			}

			// Readiness gates explicit status changes. An already active task that
			// takes on a new incomplete edge is instead automatically demoted below.
			if ((nextStatus === "in_progress" || nextStatus === "completed") && current.status !== nextStatus) {
				const readyError = validateDependenciesReady(state, nextDeps);
				if (readyError) return error(state, readyError);
			}

			const updated: TodoItem = { ...current, status: nextStatus };
			if (params.subject !== undefined) updated.subject = params.subject.trim();
			// Empty string removes an optional text field (metadata uses null keys).
			if (params.description !== undefined) {
				if (params.description) updated.description = params.description;
				else delete updated.description;
			}
			if (params.activeForm !== undefined) {
				if (params.activeForm) updated.activeForm = params.activeForm;
				else delete updated.activeForm;
			}
			if (params.owner !== undefined) {
				if (params.owner) updated.owner = params.owner;
				else delete updated.owner;
			}
			if (nextDeps.length) updated.blockedBy = nextDeps;
			else delete updated.blockedBy;
			if (params.metadata !== undefined) {
				if (metadata) updated.metadata = metadata;
				else delete updated.metadata;
			}

			const items = state.items.map((task) => {
				if (task.id === current.id) return updated;
				const deps = nextDepsById.get(task.id);
				if (deps === undefined) return task;
				return deps.length ? { ...task, blockedBy: deps } : omitBlockedBy(task);
			});

			// A task that was already active may become newly blocked through either
			// direction of an edge edit. Keep it out of in_progress and distinguish
			// this from the usual single-active-task demotion in the result.
			const blockedIds: number[] = [];
			for (const [targetId, deps] of nextDepsById) {
				const before = findItem(state, targetId);
				const targetIndex = items.findIndex((item) => item.id === targetId);
				if (!before || targetIndex === -1 || items[targetIndex].status !== "in_progress") continue;
				const previousDeps = before.blockedBy ?? [];
				const gainedUnresolved = deps.some((dependencyId) => {
					if (previousDeps.includes(dependencyId)) return false;
					const dependency = items.find((item) => item.id === dependencyId);
					return dependency?.status !== "completed";
				});
				if (gainedUnresolved) {
					items[targetIndex] = { ...items[targetIndex], status: "pending" };
					blockedIds.push(targetId);
				}
			}

			// Exactly one in_progress: demote any other active tasks to pending.
			const demotedIds: number[] = [];
			const finalCurrent = items[index];
			if (nextStatus === "in_progress" && finalCurrent.status === "in_progress") {
				for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
					const item = items[itemIndex];
					if (item.id === finalCurrent.id || item.status !== "in_progress") continue;
					items[itemIndex] = { ...item, status: "pending" };
					demotedIds.push(item.id);
				}
			}

			const nextState: TodoState = { items, nextId: state.nextId };
			const finalItem = items[index];
			const newlyCompleted = current.status !== "completed" && finalItem.status === "completed";
			return {
				state: nextState,
				operation: {
					kind: "update",
					id: finalItem.id,
					from: current.status,
					to: finalItem.status,
					...(demotedIds.length ? { demotedIds } : {}),
					...(blockedIds.length ? { blockedIds } : {}),
					...(newlyCompleted && needsVerificationNudge(nextState) ? { verificationNudge: true } : {}),
				},
			};
		}

		case "list": {
			if (params.status !== undefined && !isTodoStatus(params.status)) return error(state, "status is invalid");
			if (params.includeDeleted !== undefined && typeof params.includeDeleted !== "boolean") {
				return error(state, "includeDeleted must be a boolean");
			}
			if (params.unblockedOnly !== undefined && typeof params.unblockedOnly !== "boolean") {
				return error(state, "unblockedOnly must be a boolean");
			}
			if (
				params.limit !== undefined &&
				(!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > TODO_MAX_LIST_LIMIT)
			) {
				return error(state, `limit must be an integer from 1 to ${TODO_MAX_LIST_LIMIT}`);
			}
			if (params.afterId !== undefined && !isPositiveInteger(params.afterId))
				return error(state, "afterId must be a positive integer");
			if (params.query !== undefined) {
				const queryError = validateBoundedString(params.query, "query", TODO_MAX_LIST_QUERY_LENGTH);
				if (queryError) return error(state, queryError);
			}
			return {
				state,
				operation: {
					kind: "list",
					status: params.status,
					includeDeleted: params.includeDeleted === true,
					limit: params.limit ?? LIST_DISPLAY_MAX_ITEMS,
					...(params.afterId !== undefined ? { afterId: params.afterId } : {}),
					...(params.query !== undefined ? { query: params.query } : {}),
					unblockedOnly: params.unblockedOnly === true,
					legacyOutput:
						params.limit === undefined &&
						params.afterId === undefined &&
						params.query === undefined &&
						params.unblockedOnly === undefined,
				},
			};
		}

		case "get": {
			if (!isPositiveInteger(params.id)) return error(state, "id required for get");
			const item = findItem(state, params.id);
			if (!item) return error(state, `#${params.id} not found`);
			return { state, operation: { kind: "get", item } };
		}

		case "delete": {
			if (!isPositiveInteger(params.id)) return error(state, "id required for delete");
			const index = state.items.findIndex((item) => item.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const current = state.items[index];
			if (current.status === "deleted") return error(state, `#${params.id} is already deleted`);

			const deleted = markDeleted(state, current.id);
			return {
				state: deleted.state,
				operation: {
					kind: "delete",
					id: current.id,
					subject: current.subject,
					...(deleted.releasedIds.length ? { releasedIds: deleted.releasedIds } : {}),
				},
			};
		}

		case "clear":
			if (params.confirm !== true) return error(state, "clear requires confirm: true");
			if (!Number.isSafeInteger(params.expectedCount) || params.expectedCount !== state.items.length) {
				return error(state, `clear expectedCount must equal current task count (${state.items.length})`);
			}
			return {
				// IDs remain monotonic across a clear so stale references cannot point
				// at an unrelated task created later on the same conversation branch.
				state: { items: [], nextId: state.nextId },
				operation: { kind: "clear", count: state.items.length },
			};
	}
}

function isTodoStatusCounts(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	for (const [status, count] of Object.entries(value)) {
		if (!isTodoStatus(status) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false;
	}
	return true;
}

function isOperationSummary(value: unknown, action: TodoAction): value is TodoOperationSummary {
	if (!isPlainRecord(value) || value.kind !== action) return false;
	switch (action) {
		case "create":
		case "create_many":
			return Array.isArray(value.ids) && value.ids.every(isPositiveInteger);
		case "update":
			return isPositiveInteger(value.id) && isTodoStatus(value.status);
		case "list":
			return (
				typeof value.includeDeleted === "boolean" &&
				typeof value.unblockedOnly === "boolean" &&
				(value.status === undefined || isTodoStatus(value.status)) &&
				(value.limit === undefined ||
					(typeof value.limit === "number" && Number.isSafeInteger(value.limit) && value.limit >= 1)) &&
				(value.afterId === undefined || isPositiveInteger(value.afterId)) &&
				(value.query === undefined || typeof value.query === "string") &&
				(value.statusCounts === undefined || isTodoStatusCounts(value.statusCounts)) &&
				(value.resultCount === undefined ||
					(typeof value.resultCount === "number" &&
						Number.isSafeInteger(value.resultCount) &&
						value.resultCount >= 0))
			);
		case "get":
		case "delete":
			return isPositiveInteger(value.id);
		case "clear":
			return typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0;
	}
}

function normalizeSnapshotState(itemsValue: unknown, nextIdValue: unknown): TodoState | undefined {
	if (!Array.isArray(itemsValue) || !isPositiveInteger(nextIdValue)) return undefined;
	const items: TodoItem[] = [];
	const ids = new Set<number>();
	const itemsById = new Map<number, TodoItem>();
	for (const rawItem of itemsValue) {
		if (!isPlainRecord(rawItem) || !isPositiveInteger(rawItem.id) || ids.has(rawItem.id)) return undefined;
		if (typeof rawItem.subject !== "string" || !isTodoStatus(rawItem.status)) return undefined;
		if (rawItem.description !== undefined && typeof rawItem.description !== "string") return undefined;
		if (rawItem.activeForm !== undefined && typeof rawItem.activeForm !== "string") return undefined;
		if (rawItem.owner !== undefined && typeof rawItem.owner !== "string") return undefined;
		let blockedBy: number[] | undefined;
		if (rawItem.blockedBy !== undefined) {
			if (!Array.isArray(rawItem.blockedBy) || !rawItem.blockedBy.every(isPositiveInteger)) return undefined;
			blockedBy = Array.from(new Set(rawItem.blockedBy));
		}
		let metadata: Record<string, unknown> | undefined;
		if (rawItem.metadata !== undefined) {
			const metadataResult = validateAndCloneMetadata(rawItem.metadata, LEGACY_METADATA_LIMITS);
			if ("error" in metadataResult) return undefined;
			metadata = metadataResult.metadata;
		}
		const item: TodoItem = { id: rawItem.id, subject: rawItem.subject, status: rawItem.status };
		if (rawItem.description !== undefined) item.description = rawItem.description;
		if (rawItem.activeForm !== undefined) item.activeForm = rawItem.activeForm;
		if (blockedBy?.length) item.blockedBy = blockedBy;
		if (rawItem.owner !== undefined) item.owner = rawItem.owner;
		if (metadata) item.metadata = metadata;
		items.push(item);
		itemsById.set(item.id, item);
		ids.add(item.id);
	}
	const highestId = items.reduce((highest, item) => Math.max(highest, item.id), 0);
	if (nextIdValue <= highestId) return undefined;
	for (const item of items) {
		for (const dependencyId of item.blockedBy ?? []) {
			const dependency = itemsById.get(dependencyId);
			if (!dependency || dependency.status === "deleted") return undefined;
		}
	}
	if (createsCycle(items, new Map<number, number[]>())) return undefined;

	// Legacy snapshots could contain the formerly permitted "active but newly
	// blocked" state. Normalize it to the current invariant rather than losing
	// the newest otherwise-valid task list during replay.
	for (const item of items) {
		if (item.status !== "in_progress") continue;
		if ((item.blockedBy ?? []).some((id) => itemsById.get(id)?.status !== "completed")) {
			item.status = "pending";
		}
	}
	if (items.filter((item) => item.status === "in_progress").length > 1) return undefined;
	items.sort((first, second) => first.id - second.id);
	return { items, nextId: nextIdValue };
}

function normalizeDetails(value: unknown): TodoState | undefined {
	if (!isPlainRecord(value) || !isTodoAction(value.action) || !isPlainRecord(value.params)) return undefined;
	if (value.schemaVersion !== undefined) {
		if (value.schemaVersion !== TODO_DETAILS_SCHEMA_VERSION || !isOperationSummary(value.operation, value.action)) {
			return undefined;
		}
	}
	return normalizeSnapshotState(value.items, value.nextId);
}

export function replayTodosFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
	// Latest valid todo toolResult wins; scan tail → head so malformed latest
	// snapshots cannot poison a branch that still has an earlier valid state.
	const branch = Array.from(ctx.sessionManager.getBranch());
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "toolResult" || entry.message.toolName !== TODO_TOOL_NAME) continue;
		let state: TodoState | undefined;
		try {
			state = normalizeDetails(entry.message.details);
		} catch {
			// Session history is external input; ignore hostile or malformed details.
			continue;
		}
		if (state) return cloneState(state);
	}
	return cloneState(EMPTY_TODO_STATE);
}

function cloneDetailsParams(params: TodoParams): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		if (key === "metadata") {
			const metadata = validateAndCloneMetadata(value, LEGACY_METADATA_LIMITS);
			if ("metadata" in metadata) copy[key] = metadata.metadata;
			continue;
		}
		if (key === "items" && Array.isArray(value)) {
			copy[key] = value.map((item) => {
				if (!isPlainRecord(item)) return item;
				const itemCopy: Record<string, unknown> = { ...item };
				if (item.metadata !== undefined) {
					const metadata = validateAndCloneMetadata(item.metadata, LEGACY_METADATA_LIMITS);
					if ("metadata" in metadata) itemCopy.metadata = metadata.metadata;
				}
				return itemCopy;
			});
			continue;
		}
		copy[key] = value;
	}
	return copy;
}

function buildTodoOperationSummary(params: TodoParams, next: TodoState): TodoOperationSummary {
	switch (params.action) {
		case "create":
			return { kind: "create", ids: [next.nextId - 1] };
		case "create_many": {
			const count = Array.isArray(params.items) ? params.items.length : 0;
			const firstId = next.nextId - count;
			return { kind: "create_many", ids: Array.from({ length: count }, (_, index) => firstId + index) };
		}
		case "update": {
			const item = findItem(next, params.id as number);
			return { kind: "update", id: params.id as number, status: item?.status ?? "pending" };
		}
		case "list": {
			const listOperation: Extract<Operation, { kind: "list" }> = {
				kind: "list",
				...(params.status !== undefined ? { status: params.status } : {}),
				includeDeleted: params.includeDeleted === true,
				limit: params.limit ?? LIST_DISPLAY_MAX_ITEMS,
				...(params.afterId !== undefined ? { afterId: params.afterId } : {}),
				...(params.query !== undefined ? { query: params.query } : {}),
				unblockedOnly: params.unblockedOnly === true,
				legacyOutput: false,
			};
			const shown = getListView(listOperation, next).slice(0, listOperation.limit);
			const statusCounts: Partial<Record<TodoStatus, number>> = {};
			for (const item of shown) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
			return {
				kind: "list",
				...(listOperation.status !== undefined ? { status: listOperation.status } : {}),
				includeDeleted: listOperation.includeDeleted,
				limit: listOperation.limit,
				...(listOperation.afterId !== undefined ? { afterId: listOperation.afterId } : {}),
				...(listOperation.query !== undefined ? { query: listOperation.query } : {}),
				unblockedOnly: listOperation.unblockedOnly,
				statusCounts,
				resultCount: shown.length,
			};
		}
		case "get":
			return { kind: "get", id: params.id as number };
		case "delete":
			return { kind: "delete", id: params.id as number };
		case "clear":
			return { kind: "clear", count: params.expectedCount as number };
	}
}

export function buildTodoDetails(params: TodoParams, next: TodoState): TodoDetails {
	const snapshot = cloneState(next);
	return {
		schemaVersion: TODO_DETAILS_SCHEMA_VERSION,
		action: params.action,
		params: cloneDetailsParams(params),
		operation: buildTodoOperationSummary(params, snapshot),
		items: snapshot.items,
		nextId: snapshot.nextId,
	};
}

const VERIFICATION_NUDGE_NOTE =
	"NOTE: You closed out 3+ tasks with no verification/test/review step. Before the final summary, run checks or add a verification task and complete it — do not self-declare done with known failures.";

function formatReleasedSuffix(releasedIds: number[] | undefined): string {
	if (!releasedIds?.length) return "";
	return `; released ${releasedIds.map((id) => `#${id}`).join(",")} (no longer blocked)`;
}

function formatDisplayText(value: string, maximum: number): string {
	return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

function getListView(operation: Extract<Operation, { kind: "list" }>, state: TodoState): TodoItem[] {
	let view = state.items;
	// An explicit deleted-status query is sufficient intent to include tombstones.
	if (!operation.includeDeleted && operation.status !== "deleted") {
		view = view.filter((item) => item.status !== "deleted");
	}
	if (operation.status) view = view.filter((item) => item.status === operation.status);
	if (operation.afterId !== undefined) {
		const afterId = operation.afterId;
		view = view.filter((item) => item.id > afterId);
	}
	if (operation.query !== undefined) {
		const query = operation.query.toLocaleLowerCase();
		view = view.filter(
			(item) =>
				item.subject.toLocaleLowerCase().includes(query) || item.description?.toLocaleLowerCase().includes(query),
		);
	}
	if (operation.unblockedOnly) view = view.filter((item) => dependenciesSatisfied(state, item));
	return [...view].sort((first, second) => first.id - second.id);
}

export function formatTodoContent(operation: Operation, state: TodoState): string {
	switch (operation.kind) {
		case "create": {
			const item = findItem(state, operation.id);
			return item
				? `Created #${item.id}: ${formatDisplayText(item.subject, TODO_MAX_SUBJECT_LENGTH)} (pending)`
				: `Created #${operation.id}`;
		}
		case "create_many":
			return `Created ${operation.ids.length} tasks: ${operation.ids.map((id) => `#${id}`).join(", ")}`;
		case "update": {
			const transition = operation.from === operation.to ? "" : ` (${operation.from} -> ${operation.to})`;
			let text = `Updated #${operation.id}${transition}`;
			if (operation.demotedIds?.length) {
				text += `; ${operation.demotedIds.map((id) => `#${id}`).join(",")} demoted to pending`;
			}
			if (operation.blockedIds?.length) {
				text += `; ${operation.blockedIds.map((id) => `#${id}`).join(",")} moved to pending (dependencies incomplete)`;
			}
			text += formatReleasedSuffix(operation.releasedIds);
			if (operation.verificationNudge) text += `\n\n${VERIFICATION_NUDGE_NOTE}`;
			return text;
		}
		case "delete":
			return `Deleted #${operation.id}: ${formatDisplayText(operation.subject, TODO_MAX_SUBJECT_LENGTH)}${formatReleasedSuffix(operation.releasedIds)}`;
		case "clear":
			return `Cleared ${operation.count} tasks`;
		case "list":
			return formatBoundedList(getListView(operation, state), state, operation);
		case "get":
			return formatDetailItem(operation.item, state);
		case "error":
			return `Error: ${operation.message}`;
	}
}

/**
 * Soft nudge when the whole list is done (no active work), there are 3+ completed
 * tasks, and none look like a verification/test/review step — mirrors CC TodoWrite.
 */
function needsVerificationNudge(state: TodoState): boolean {
	const active = state.items.filter((item) => item.status !== "deleted");
	if (active.length < 3) return false;
	if (active.some((item) => item.status === "pending" || item.status === "in_progress")) return false;
	const completed = active.filter((item) => item.status === "completed");
	if (completed.length < 3) return false;
	return !completed.some(
		(item) =>
			VERIFICATION_PATTERN.test(item.subject) ||
			(item.description !== undefined && VERIFICATION_PATTERN.test(item.description)),
	);
}

function formatBoundedList(
	view: TodoItem[],
	state: TodoState,
	operation: Extract<Operation, { kind: "list" }>,
): string {
	if (!view.length) return "No tasks";
	const shown = view.slice(0, operation.limit);
	const lines = shown.map((item) => formatListItem(item, state));
	const omitted = view.length - shown.length;
	if (omitted > 0) {
		if (!operation.legacyOutput) {
			lines.push(`… and ${omitted} more; next page: afterId=${shown.at(-1)?.id}.`);
		} else {
			// Do not suggest a filter that is already applied.
			const hint = operation.status ? "use get with id= for details" : "narrow with status= or use get with id=";
			lines.push(`… and ${omitted} more (${shown.length} of ${view.length} shown); ${hint}.`);
		}
	}
	return lines.join("\n");
}

function formatListIdList(ids: number[]): string {
	const shown = ids.slice(0, TODO_MAX_BLOCKED_BY).map((id) => `#${id}`);
	return ids.length > shown.length ? `${shown.join(",")},…+${ids.length - shown.length}` : shown.join(",");
}

function formatListItem(item: TodoItem, state: TodoState): string {
	const unresolved = unresolvedDependencyIds(state, item);
	const deps = unresolved.length ? ` blockedBy=${formatListIdList(unresolved)}` : "";
	const owner = item.owner ? ` @${formatDisplayText(item.owner, TODO_MAX_OWNER_LENGTH)}` : "";
	const active =
		item.status === "in_progress" && item.activeForm
			? ` (${formatDisplayText(item.activeForm, TODO_MAX_ACTIVE_FORM_LENGTH)})`
			: "";
	return `[${item.status}] #${item.id} ${formatDisplayText(item.subject, TODO_MAX_SUBJECT_LENGTH)}${active}${owner}${deps}`;
}

function formatIdList(ids: number[]): string {
	const shown = ids.slice(0, TODO_MAX_BLOCKED_BY).map((id) => `#${id}`);
	return ids.length > shown.length ? `${shown.join(", ")}, … +${ids.length - shown.length}` : shown.join(", ");
}

function formatDetailItem(item: TodoItem, state: TodoState): string {
	const lines = [`#${item.id} [${item.status}] ${formatDisplayText(item.subject, TODO_MAX_SUBJECT_LENGTH)}`];
	if (item.description) lines.push(`description: ${formatDisplayText(item.description, TODO_MAX_DESCRIPTION_LENGTH)}`);
	if (item.activeForm) lines.push(`activeForm: ${formatDisplayText(item.activeForm, TODO_MAX_ACTIVE_FORM_LENGTH)}`);
	if (item.blockedBy?.length) lines.push(`blockedBy: ${formatIdList(item.blockedBy)}`);
	const blocks = state.items
		.filter((candidate) => candidate.blockedBy?.includes(item.id))
		.map((candidate) => candidate.id);
	if (blocks.length) lines.push(`blocks: ${formatIdList(blocks)}`);
	if (item.owner) lines.push(`owner: ${formatDisplayText(item.owner, TODO_MAX_OWNER_LENGTH)}`);
	return lines.join("\n");
}
