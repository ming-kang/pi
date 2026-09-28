/**
 * todo/schema.ts — v3 tool parameters, state shape, and operation model.
 *
 * One call is one patch: the three group fields (create, update, delete) are
 * applied together, there is no action discriminator. The shape is built for
 * strict constrained sampling: optional groups can be null or empty and every
 * filler value a strict sampler may emit ([], "", null) is a harmless no-op.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { TODO_MAX_BATCH_ITEMS, TODO_MAX_DESCRIPTION_LENGTH, TODO_MAX_SUBJECT_LENGTH } from "./constants.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

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
export const TODO_DETAILS_SCHEMA_VERSION = 3;

/**
 * What one call changed, as a flat patch record. Every list is empty for a
 * pure list call; `demotedId` is present only when an activation pushed the
 * previously active task back to pending.
 */
export interface TodoChange {
	created: number[];
	/** Explicitly updated tasks, from their prior status to the final snapshot status. */
	updated: Array<{ id: number; from: TodoStatus; to: TodoStatus }>;
	deleted: Array<{ id: number; subject: string }>;
	absent: number[];
	evicted: Array<{ id: number; subject: string }>;
	demotedId?: number;
}

export interface TodoDetails {
	schemaVersion: typeof TODO_DETAILS_SCHEMA_VERSION;
	change: TodoChange;
	state: TodoState;
}

const StatusSchema = StringEnum(["pending", "in_progress", "completed"] as const, {
	description:
		"Task status: pending for future work, in_progress for the single active task, completed for verified done work. At most one task may be in_progress; setting one demotes any other active task to pending.",
});

const TaskIdSchema = Type.Integer({ minimum: 1, description: "Positive task id." });

const CreateItemSchema = Type.Object(
	{
		subject: Type.String({
			maxLength: TODO_MAX_SUBJECT_LENGTH,
			description: "Short imperative task subject; a reviewable unit of work.",
		}),
		description: Type.String({
			maxLength: TODO_MAX_DESCRIPTION_LENGTH,
			description: "What done means for this task: acceptance criteria or verification detail.",
		}),
		status: Type.Optional(StatusSchema),
	},
	{ additionalProperties: false },
);

const UpdateItemSchema = Type.Object(
	{
		id: TaskIdSchema,
		subject: Type.Optional(
			Type.String({
				maxLength: TODO_MAX_SUBJECT_LENGTH,
				description: "Replacement subject; blank or omitted keeps the current one.",
			}),
		),
		description: Type.Optional(
			Type.String({
				maxLength: TODO_MAX_DESCRIPTION_LENGTH,
				description: "Replacement description (what done means); blank or omitted keeps the current one.",
			}),
		),
		status: Type.Optional(StatusSchema),
	},
	{ additionalProperties: false },
);

export const TodoParamsSchema = Type.Object(
	{
		create: Type.Optional(
			Type.Array(CreateItemSchema, {
				maxItems: TODO_MAX_BATCH_ITEMS,
				description: "Tasks to add, created atomically in input order; status defaults to pending.",
			}),
		),
		update: Type.Optional(
			Type.Array(UpdateItemSchema, {
				maxItems: TODO_MAX_BATCH_ITEMS,
				description: "Task edits by id; blank or omitted fields keep their current values.",
			}),
		),
		delete: Type.Optional(
			Type.Array(TaskIdSchema, {
				maxItems: TODO_MAX_BATCH_ITEMS,
				description: "Ids to remove from the current list; deleting an id that is already absent is a no-op.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TodoParams = Static<typeof TodoParamsSchema>;

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };
