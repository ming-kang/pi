import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { MAX_CONCURRENCY, MAX_TASKS, SUBAGENT_AGENT_NAMES } from "./constants.ts";

// Strict constrained-sampling providers treat every property as required
// and reject bare unions at the top level, so the schema is a flat
// `type: "object"` whose optional fields are also nullable: callers omit
// a field when the grammar allows it and send null when it does not.
function nullable<T extends TSchema>(schema: T, description: string) {
	return Type.Optional(Type.Union([schema, Type.Null()], { description }));
}

export const TaskSchema = Type.Object(
	{
		agent: nullable(
			StringEnum(SUBAGENT_AGENT_NAMES, { description: "Which built-in profile runs this task" }),
			"Built-in profile; null or omit for explorer (the default)",
		),
		prompt: Type.String({
			minLength: 1,
			maxLength: 50_000,
			description: "Complete self-contained briefing; the worker cannot see the parent conversation",
		}),
		description: nullable(
			Type.String({ minLength: 1, maxLength: 80 }),
			"Short task label (3-5 words) shown in the /bg list, live rows, and report headings; null or omit to derive it from the prompt",
		),
		cwd: nullable(
			Type.String({ minLength: 1, maxLength: 4_096 }),
			"Relative or absolute directory inside the parent working directory; null or omit to inherit it",
		),
	},
	{ additionalProperties: false },
);

export const SubagentParamsSchema = Type.Object(
	{
		background: nullable(
			Type.Boolean(),
			"true runs all tasks as one managed background group and returns a group reference immediately; false, null or omit blocks until every worker finishes and returns their reports",
		),
		tasks: Type.Array(TaskSchema, {
			minItems: 1,
			maxItems: MAX_TASKS,
			description: `Independent tasks run concurrently: at most ${MAX_CONCURRENCY} active at once, excess tasks queue, and results preserve input order`,
		}),
	},
	{ additionalProperties: false },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type SubagentTask = Static<typeof TaskSchema>;
