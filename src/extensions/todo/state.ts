import { LIST_DISPLAY_MAX_ITEMS, TODO_TOOL_NAME } from "./constants.ts";
import {
	EMPTY_TODO_STATE,
	type TodoAction,
	type TodoDetails,
	type TodoItem,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";

type Operation =
	| { kind: "create"; id: number }
	| {
			kind: "update";
			id: number;
			from: TodoStatus;
			to: TodoStatus;
			/** Other tasks auto-demoted from in_progress → pending to keep exactly one active. */
			demotedIds?: number[];
			/** Pending dependents left fully unblocked by an update to status deleted. */
			releasedIds?: number[];
			/** Soft note when the list is fully closed without a verification-style task. */
			verificationNudge?: boolean;
	  }
	| { kind: "delete"; id: number; subject: string; releasedIds?: number[] }
	| { kind: "list"; status?: TodoStatus; includeDeleted: boolean }
	| { kind: "get"; item: TodoItem }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

/** Subjects/descriptions that count as a verification step (CC-style soft nudge). */
const VERIFICATION_PATTERN = /verif|test|check|review/i;

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

export function cloneState(source: TodoState): TodoState {
	return {
		items: source.items.map((item) => {
			const clone: TodoItem = { ...item };
			if (item.blockedBy) clone.blockedBy = [...item.blockedBy];
			else delete clone.blockedBy;
			if (item.metadata) clone.metadata = { ...item.metadata };
			else delete clone.metadata;
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
	list: new Set(["status", "includeDeleted"]),
	get: new Set(["id"]),
	delete: new Set(["id"]),
	clear: new Set<string>(),
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

function validateDependencies(state: TodoState, deps: number[] | undefined, currentId?: number): string | undefined {
	if (!deps?.length) return undefined;
	for (const dep of deps) {
		if (dep === currentId) return `cannot block #${currentId} on itself`;
		const item = findItem(state, dep);
		if (!item) return `blockedBy: #${dep} not found`;
		if (item.status === "deleted") return `blockedBy: #${dep} is deleted`;
	}
	return undefined;
}

/** All listed dependencies must be completed before starting or closing a task. */
function validateDependenciesReady(state: TodoState, deps: number[] | undefined): string | undefined {
	if (!deps?.length) return undefined;
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

/** True when any task whose deps change in nextDepsById can reach itself through blockedBy edges. */
function createsCycle(items: TodoItem[], nextDepsById: ReadonlyMap<number, number[]>): boolean {
	const depsById = new Map<number, number[]>();
	for (const item of items) depsById.set(item.id, item.blockedBy ?? []);
	for (const [id, deps] of nextDepsById) depsById.set(id, deps);

	const seen = new Set<number>();
	const stack = new Set<number>();

	function visit(node: number): boolean {
		if (stack.has(node)) return true;
		if (seen.has(node)) return false;
		seen.add(node);
		stack.add(node);
		for (const dep of depsById.get(node) ?? []) {
			if (visit(dep)) return true;
		}
		stack.delete(node);
		return false;
	}

	for (const id of nextDepsById.keys()) {
		if (visit(id)) return true;
	}
	return false;
}

export function applyTodoMutation(input: TodoState, params: TodoParams): MutationResult {
	const state = cloneState(input);

	const inapplicable = findInapplicableParam(params);
	if (inapplicable) return error(state, inapplicable);

	switch (params.action) {
		case "create": {
			const subject = params.subject?.trim();
			if (!subject) return error(state, "subject required for create");
			if (!params.description?.trim()) {
				return error(state, "description required for create: state what done means for this task");
			}
			if (params.status !== undefined && params.status !== "pending") {
				return error(state, "create always starts pending; use update to start or complete a task");
			}
			const dependencyError = validateDependencies(state, params.blockedBy);
			if (dependencyError) return error(state, dependencyError);

			const item: TodoItem = {
				id: state.nextId,
				subject,
				status: "pending",
				description: params.description,
			};
			if (params.activeForm) item.activeForm = params.activeForm;
			if (params.blockedBy?.length) item.blockedBy = Array.from(new Set<number>(params.blockedBy));
			if (params.owner) item.owner = params.owner;
			if (params.metadata) item.metadata = { ...params.metadata };

			return {
				state: { items: [...state.items, item], nextId: state.nextId + 1 },
				operation: { kind: "create", id: item.id },
			};
		}

		case "update": {
			if (params.id === undefined) return error(state, "id required for update");
			const index = state.items.findIndex((item) => item.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const current = state.items[index];
			if (current.status === "deleted") return error(state, `#${params.id} is deleted and cannot be updated`);
			if (params.subject !== undefined && !params.subject.trim()) return error(state, "subject cannot be empty");

			const edgeChange =
				(params.addBlockedBy?.length ?? 0) > 0 ||
				(params.removeBlockedBy?.length ?? 0) > 0 ||
				(params.addBlocks?.length ?? 0) > 0 ||
				(params.removeBlocks?.length ?? 0) > 0;
			const fieldChange =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined;
			if (!fieldChange && !edgeChange && params.status === undefined) {
				return error(state, "update requires at least one field");
			}

			// `status: deleted` is the update form of delete; keep its dependency
			// cleanup identical to the dedicated delete action. Other edits do not
			// combine with it: a tombstone is immutable, so applying them would
			// silently produce an unreachable revision.
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

			// Collect every task whose blockedBy changes: this task (addBlockedBy /
			// removeBlockedBy) plus reverse-edge targets (addBlocks / removeBlocks).
			const nextDepsById = new Map<number, number[]>();
			let nextDeps = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const remove = new Set(params.removeBlockedBy);
				nextDeps = nextDeps.filter((id) => !remove.has(id));
			}
			if (params.addBlockedBy?.length) {
				const dependencyError = validateDependencies(state, params.addBlockedBy, current.id);
				if (dependencyError) return error(state, dependencyError);
				for (const dep of params.addBlockedBy) {
					if (!nextDeps.includes(dep)) nextDeps.push(dep);
				}
			}
			nextDepsById.set(current.id, nextDeps);

			if (params.removeBlocks?.length) {
				const release = new Set(params.removeBlocks);
				for (const candidate of state.items) {
					if (!release.has(candidate.id) || !candidate.blockedBy?.includes(current.id)) continue;
					nextDepsById.set(
						candidate.id,
						candidate.blockedBy.filter((dependencyId) => dependencyId !== current.id),
					);
				}
			}
			if (params.addBlocks?.length) {
				for (const targetId of params.addBlocks) {
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

			// Readiness gates only status *changes*: an already-active task may take
			// on a new incomplete dependency — a prerequisite discovered mid-work.
			// The overlay flags it as "deps incomplete" instead.
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
				const merged = { ...(current.metadata ?? {}) };
				for (const [key, value] of Object.entries(params.metadata)) {
					if (value === null) delete merged[key];
					else merged[key] = value;
				}
				if (Object.keys(merged).length) updated.metadata = merged;
				else delete updated.metadata;
			}

			const items = state.items.map((task) => {
				if (task.id === current.id) return task;
				const deps = nextDepsById.get(task.id);
				if (deps === undefined) return task;
				return deps.length ? { ...task, blockedBy: deps } : omitBlockedBy(task);
			});
			items[index] = updated;

			// Exactly one in_progress: demote any other active tasks to pending.
			const demotedIds: number[] = [];
			if (nextStatus === "in_progress") {
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					if (item.id === updated.id) continue;
					if (item.status !== "in_progress") continue;
					items[i] = { ...item, status: "pending" };
					demotedIds.push(item.id);
				}
			}

			const nextState: TodoState = { items, nextId: state.nextId };
			const newlyCompleted = current.status !== "completed" && nextStatus === "completed";
			return {
				state: nextState,
				operation: {
					kind: "update",
					id: updated.id,
					from: current.status,
					to: updated.status,
					...(demotedIds.length ? { demotedIds } : {}),
					...(newlyCompleted && needsVerificationNudge(nextState) ? { verificationNudge: true } : {}),
				},
			};
		}

		case "list":
			return {
				state,
				operation: {
					kind: "list",
					status: params.status,
					includeDeleted: params.includeDeleted === true,
				},
			};

		case "get": {
			if (params.id === undefined) return error(state, "id required for get");
			const item = findItem(state, params.id);
			if (!item) return error(state, `#${params.id} not found`);
			return { state, operation: { kind: "get", item } };
		}

		case "delete": {
			if (params.id === undefined) return error(state, "id required for delete");
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
			return {
				// IDs remain monotonic across a clear so stale references cannot point
				// at an unrelated task created later on the same conversation branch.
				state: { items: [], nextId: state.nextId },
				operation: { kind: "clear", count: state.items.length },
			};
	}

	return error(state, `unknown action: ${(params as { action?: unknown }).action}`);
}

function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return Array.isArray(record.items) && typeof record.nextId === "number";
}

export function replayTodosFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
	// Latest todo toolResult wins; scan tail → head so long branches stop early.
	const branch = Array.from(ctx.sessionManager.getBranch());
	for (let i = branch.length - 1; i >= 0; i--) {
		const item = branch[i] as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (item.type !== "message") continue;
		if (item.message?.role !== "toolResult" || item.message.toolName !== TODO_TOOL_NAME) continue;
		if (!isTodoDetails(item.message.details)) continue;
		return cloneState({
			items: item.message.details.items,
			nextId: item.message.details.nextId,
		});
	}
	return cloneState(EMPTY_TODO_STATE);
}

export function buildTodoDetails(params: TodoParams, next: TodoState): TodoDetails {
	return {
		action: params.action,
		params: params as Record<string, unknown>,
		items: cloneState(next).items,
		nextId: next.nextId,
	};
}

const VERIFICATION_NUDGE_NOTE =
	"NOTE: You closed out 3+ tasks with no verification/test/review step. Before the final summary, run checks or add a verification task and complete it — do not self-declare done with known failures.";

function formatReleasedSuffix(releasedIds: number[] | undefined): string {
	if (!releasedIds?.length) return "";
	return `; released ${releasedIds.map((id) => `#${id}`).join(",")} (no longer blocked)`;
}

export function formatTodoContent(operation: Operation, state: TodoState): string {
	switch (operation.kind) {
		case "create": {
			const item = findItem(state, operation.id);
			return item ? `Created #${item.id}: ${item.subject} (pending)` : `Created #${operation.id}`;
		}
		case "update": {
			const transition = operation.from === operation.to ? "" : ` (${operation.from} -> ${operation.to})`;
			let text = `Updated #${operation.id}${transition}`;
			if (operation.demotedIds?.length) {
				text += `; ${operation.demotedIds.map((id) => `#${id}`).join(",")} demoted to pending`;
			}
			text += formatReleasedSuffix(operation.releasedIds);
			if (operation.verificationNudge) text += `\n\n${VERIFICATION_NUDGE_NOTE}`;
			return text;
		}
		case "delete":
			return `Deleted #${operation.id}: ${operation.subject}${formatReleasedSuffix(operation.releasedIds)}`;
		case "clear":
			return `Cleared ${operation.count} tasks`;
		case "list": {
			let view = state.items;
			// An explicit deleted-status query is sufficient intent to include tombstones.
			if (!operation.includeDeleted && operation.status !== "deleted")
				view = view.filter((item) => item.status !== "deleted");
			if (operation.status) view = view.filter((item) => item.status === operation.status);
			return formatBoundedList(view, state, operation.status);
		}
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

function formatBoundedList(view: TodoItem[], state: TodoState, statusFilter: TodoStatus | undefined): string {
	if (!view.length) return "No tasks";
	const shown = view.slice(0, LIST_DISPLAY_MAX_ITEMS);
	const lines = shown.map((item) => formatListItem(item, state));
	const omitted = view.length - shown.length;
	if (omitted > 0) {
		// Do not suggest a filter that is already applied.
		const hint = statusFilter ? "use get with id= for details" : "narrow with status= or use get with id=";
		lines.push(`… and ${omitted} more (${shown.length} of ${view.length} shown); ${hint}.`);
	}
	return lines.join("\n");
}

function formatListItem(item: TodoItem, state: TodoState): string {
	const unresolved = unresolvedDependencyIds(state, item);
	const deps = unresolved.length ? ` blockedBy=${unresolved.map((id) => `#${id}`).join(",")}` : "";
	const owner = item.owner ? ` @${item.owner}` : "";
	const active = item.status === "in_progress" && item.activeForm ? ` (${item.activeForm})` : "";
	return `[${item.status}] #${item.id} ${item.subject}${active}${owner}${deps}`;
}

function formatDetailItem(item: TodoItem, state: TodoState): string {
	const lines = [`#${item.id} [${item.status}] ${item.subject}`];
	if (item.description) lines.push(`description: ${item.description}`);
	if (item.activeForm) lines.push(`activeForm: ${item.activeForm}`);
	if (item.blockedBy?.length) lines.push(`blockedBy: ${item.blockedBy.map((id) => `#${id}`).join(", ")}`);
	const blocks = state.items
		.filter((candidate) => candidate.blockedBy?.includes(item.id))
		.map((candidate) => candidate.id);
	if (blocks.length) lines.push(`blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	if (item.owner) lines.push(`owner: ${item.owner}`);
	return lines.join("\n");
}
