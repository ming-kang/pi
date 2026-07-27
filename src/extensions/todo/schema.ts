import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import {
	TODO_MAX_ACTIVE_FORM_LENGTH,
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_BATCH_KEY_LENGTH,
	TODO_MAX_BLOCKED_BY,
	TODO_MAX_DESCRIPTION_LENGTH,
	TODO_MAX_LIST_LIMIT,
	TODO_MAX_LIST_QUERY_LENGTH,
	TODO_MAX_METADATA_ENTRIES,
	TODO_MAX_METADATA_KEY_LENGTH,
	TODO_MAX_OWNER_LENGTH,
	TODO_MAX_SUBJECT_LENGTH,
} from "./constants.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "create_many" | "update" | "list" | "get" | "delete" | "clear";

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

/** Current shape of snapshots written to todo tool results. */
export const TODO_DETAILS_SCHEMA_VERSION = 1;

export type TodoOperationSummary =
	| { kind: "create"; ids: number[] }
	| { kind: "create_many"; ids: number[] }
	| { kind: "update"; id: number; status: TodoStatus }
	| {
			kind: "list";
			status?: TodoStatus;
			includeDeleted: boolean;
			limit?: number;
			afterId?: number;
			query?: string;
			unblockedOnly: boolean;
			/** Exact status counts for the returned page, not the full snapshot. */
			statusCounts?: Partial<Record<TodoStatus, number>>;
			resultCount?: number;
	  }
	| { kind: "get"; id: number }
	| { kind: "delete"; id: number }
	| { kind: "clear"; count: number };

export interface TodoDetails {
	schemaVersion: typeof TODO_DETAILS_SCHEMA_VERSION;
	action: TodoAction;
	params: Record<string, unknown>;
	operation: TodoOperationSummary;
	items: TodoItem[];
	nextId: number;
}

const StatusSchema = StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
	description:
		"Task status: pending for future work, in_progress for the single active task, completed for verified done work, and deleted for an immutable obsolete-task tombstone. Set deleted through update or use the delete action. With action list, status also acts as a filter: only tasks with this status are listed.",
});

const ActionSchema = StringEnum(["create", "create_many", "update", "list", "get", "delete", "clear"] as const, {
	description:
		"Todo operation: create one pending task, create_many pending tasks atomically, update status/details/dependencies, list current tasks, get one task, delete an obsolete task, or clear the list with confirmation. Parameters that do not apply to the chosen action are rejected.",
});

const TaskId = (description: string) => Type.Integer({ minimum: 1, description });

const MetadataSchema = Type.Record(Type.String({ maxLength: TODO_MAX_METADATA_KEY_LENGTH }), Type.Unknown(), {
	maxProperties: TODO_MAX_METADATA_ENTRIES,
	description: "Structured JSON-like metadata. Values and total payload are validated by the tool.",
});

const CreateManyItemSchema = Type.Object({
	key: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_BATCH_KEY_LENGTH,
			description: "Optional unique batch key used by blockedByKeys references.",
		}),
	),
	subject: Type.String({
		maxLength: TODO_MAX_SUBJECT_LENGTH,
		description: "Short imperative task subject.",
	}),
	description: Type.String({
		maxLength: TODO_MAX_DESCRIPTION_LENGTH,
		description: "What done means for this task.",
	}),
	activeForm: Type.Optional(Type.String({ maxLength: TODO_MAX_ACTIVE_FORM_LENGTH })),
	blockedBy: Type.Optional(
		Type.Array(TaskId("Existing task id this task depends on."), { maxItems: TODO_MAX_BLOCKED_BY }),
	),
	blockedByKeys: Type.Optional(
		Type.Array(Type.String({ maxLength: TODO_MAX_BATCH_KEY_LENGTH }), {
			maxItems: TODO_MAX_BLOCKED_BY,
			description: "Keys of tasks in this create_many batch that must complete first.",
		}),
	),
	owner: Type.Optional(Type.String({ maxLength: TODO_MAX_OWNER_LENGTH })),
	metadata: Type.Optional(MetadataSchema),
});

export const TodoParamsSchema = Type.Object({
	action: ActionSchema,
	subject: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_SUBJECT_LENGTH,
			description:
				"Short imperative task subject, required for create; use a reviewable unit of work, not a micro-step.",
		}),
	),
	description: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_DESCRIPTION_LENGTH,
			description:
				"What done means for this task: notes, acceptance criteria, or verification detail. Required for create; on update an empty string removes it.",
		}),
	),
	activeForm: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_ACTIVE_FORM_LENGTH,
			description:
				"Present-continuous label shown while in_progress, such as 'reading code' or 'updating prompts'; on update an empty string removes it.",
		}),
	),
	status: Type.Optional(StatusSchema),
	blockedBy: Type.Optional(
		Type.Array(TaskId("Existing task id this task depends on."), {
			maxItems: TODO_MAX_BLOCKED_BY,
			description:
				"Initial dependency ids, create only (update rejects it; use addBlockedBy/removeBlockedBy there); use only for real ordering constraints.",
		}),
	),
	items: Type.Optional(
		Type.Array(CreateManyItemSchema, {
			minItems: 1,
			maxItems: TODO_MAX_BATCH_ITEMS,
			description:
				"create_many only: up to 20 pending tasks, created atomically in input order. Use key and blockedByKeys for dependencies within this batch.",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(TaskId("Existing task id that must complete first."), {
			maxItems: TODO_MAX_BLOCKED_BY,
			description: "Dependency ids to add on update; dependencies must exist and cannot create cycles.",
		}),
	),
	removeBlockedBy: Type.Optional(Type.Array(TaskId("Dependency id to detach."), { maxItems: TODO_MAX_BLOCKED_BY })),
	addBlocks: Type.Optional(
		Type.Array(TaskId("Existing task id that must wait for this one."), {
			maxItems: TODO_MAX_BLOCKED_BY,
			description:
				"Update only: ids of tasks that cannot start until this task completes (the reverse of addBlockedBy); targets must exist and cannot create cycles.",
		}),
	),
	removeBlocks: Type.Optional(Type.Array(TaskId("Dependent task id to release."), { maxItems: TODO_MAX_BLOCKED_BY })),
	owner: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_OWNER_LENGTH,
			description:
				"Optional owner or agent label for multi-agent coordination; on update an empty string removes it.",
		}),
	),
	metadata: Type.Optional(
		Type.Record(Type.String({ maxLength: TODO_MAX_METADATA_KEY_LENGTH }), Type.Unknown(), {
			maxProperties: TODO_MAX_METADATA_ENTRIES,
			description: "Optional bounded JSON-like structured metadata; null values delete keys on update.",
		}),
	),
	id: Type.Optional(TaskId("Task id, required for update, get, and delete.")),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"Include deleted tombstones in unfiltered list output; an explicit status=deleted query includes them automatically.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: TODO_MAX_LIST_LIMIT, description: "List page size (1 through 50)." }),
	),
	afterId: Type.Optional(TaskId("List only tasks with ids greater than this id.")),
	query: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_LIST_QUERY_LENGTH,
			description: "Case-insensitive subject and description search for list.",
		}),
	),
	unblockedOnly: Type.Optional(Type.Boolean({ description: "List only tasks with no unresolved dependencies." })),
	confirm: Type.Optional(Type.Boolean({ description: "clear only: must be true." })),
	expectedCount: Type.Optional(
		Type.Integer({ minimum: 0, description: "clear only: exact current task count required as a safety check." }),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };
