import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface TodoItem {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TodoStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

export interface TodoDetails {
	action: TodoAction;
	params: Record<string, unknown>;
	items: TodoItem[];
	nextId: number;
}

const StatusSchema = StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
	description:
		"Task status: pending for future work, in_progress for the single active task, completed for verified done work, and deleted for an immutable obsolete-task tombstone. Set deleted through update or use the delete action. With action list, status also acts as a filter: only tasks with this status are listed.",
});

const ActionSchema = StringEnum(["create", "update", "list", "get", "delete", "clear"] as const, {
	description:
		"Todo operation: create a pending task, update status/details/dependencies, list current tasks (optionally filtered by status), get one task, delete an obsolete task and release dependents, or clear the list without reusing ids. Parameters that do not apply to the chosen action are rejected.",
});

const TaskId = (description: string) => Type.Integer({ minimum: 1, description });

export const TodoParamsSchema = Type.Object({
	action: ActionSchema,
	subject: Type.Optional(
		Type.String({
			description:
				"Short imperative task subject, required for create; use a reviewable unit of work, not a micro-step.",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"What done means for this task: notes, acceptance criteria, or verification detail. Required for create; on update an empty string removes it.",
		}),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Present-continuous label shown while in_progress, such as 'reading code' or 'updating prompts'; on update an empty string removes it.",
		}),
	),
	status: Type.Optional(StatusSchema),
	blockedBy: Type.Optional(
		Type.Array(TaskId("Existing task id this task depends on."), {
			description:
				"Initial dependency ids, create only (update rejects it; use addBlockedBy/removeBlockedBy there); use only for real ordering constraints.",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(TaskId("Existing task id that must complete first."), {
			description: "Dependency ids to add on update; dependencies must exist and cannot create cycles.",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(TaskId("Dependency id to detach."), { description: "Dependency ids to remove on update." }),
	),
	addBlocks: Type.Optional(
		Type.Array(TaskId("Existing task id that must wait for this one."), {
			description:
				"Update only: ids of tasks that cannot start until this task completes (the reverse of addBlockedBy); targets must exist and cannot create cycles.",
		}),
	),
	removeBlocks: Type.Optional(
		Type.Array(TaskId("Dependent task id to release."), {
			description: "Update only: ids of tasks that should no longer wait for this task.",
		}),
	),
	owner: Type.Optional(
		Type.String({
			description:
				"Optional owner or agent label for multi-agent coordination; on update an empty string removes it.",
		}),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Optional structured metadata for integrations; null values delete keys on update.",
		}),
	),
	id: Type.Optional(TaskId("Task id, required for update, get, and delete.")),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"Include deleted tombstones in unfiltered list output; an explicit status=deleted query includes them automatically.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };
