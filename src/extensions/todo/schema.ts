/**
 * todo/schema.ts — v2 tool parameters, state shape, and operation model.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { TODO_MAX_BATCH_ITEMS, TODO_MAX_DESCRIPTION_LENGTH, TODO_MAX_SUBJECT_LENGTH } from "./constants.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoAction = "create" | "update" | "list" | "delete";

export interface TodoItem {
	id: number;
	subject: string;
	description: string;
	status: TodoStatus;
}

export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

/** Current shape of snapshots written to todo tool results. */
export const TODO_DETAILS_SCHEMA_VERSION = 2;

/** Single operation model: what one todo call did, independent of params. */
export type TodoChange =
	| { kind: "create"; ids: number[] }
	| { kind: "update"; id: number; from: TodoStatus; to: TodoStatus; demotedId?: number }
	| { kind: "list" }
	| { kind: "delete"; removed: Array<{ id: number; subject: string }> };

export interface TodoDetails {
	schemaVersion: typeof TODO_DETAILS_SCHEMA_VERSION;
	change: TodoChange;
	state: TodoState;
}

const StatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description:
		"Task status: pending for future work, in_progress for the single active task, completed for verified done work. Exactly one task may be in_progress; setting one demotes any other active task to pending.",
});

const ActionSchema = StringEnum(["create", "update", "list", "delete"] as const, {
	description:
		"Todo operation: create one or many pending tasks from the ordered items array, update one task by id, list all remaining tasks, or delete obsolete tasks by ids. Parameters that do not apply to the chosen action are rejected.",
});

const TaskIdSchema = Type.Integer({ minimum: 1, description: "Positive task id." });

const CreateItemSchema = Type.Object({
	subject: Type.String({
		maxLength: TODO_MAX_SUBJECT_LENGTH,
		description: "Short imperative task subject; a reviewable unit of work.",
	}),
	description: Type.String({
		maxLength: TODO_MAX_DESCRIPTION_LENGTH,
		description: "What done means for this task: acceptance criteria or verification detail.",
	}),
});

export const TodoParamsSchema = Type.Object({
	action: ActionSchema,
	items: Type.Optional(
		Type.Array(CreateItemSchema, {
			minItems: 1,
			maxItems: TODO_MAX_BATCH_ITEMS,
			description: "create only: 1 to 20 pending tasks, created atomically in input order.",
		}),
	),
	id: Type.Optional(TaskIdSchema),
	subject: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_SUBJECT_LENGTH,
			description: "update only: replacement subject.",
		}),
	),
	description: Type.Optional(
		Type.String({
			maxLength: TODO_MAX_DESCRIPTION_LENGTH,
			description: "update only: replacement description (what done means).",
		}),
	),
	status: Type.Optional(StatusSchema),
	ids: Type.Optional(
		Type.Array(TaskIdSchema, {
			minItems: 1,
			maxItems: TODO_MAX_BATCH_ITEMS,
			description: "delete only: 1 to 20 ids to remove from the current list; duplicates are ignored.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };
