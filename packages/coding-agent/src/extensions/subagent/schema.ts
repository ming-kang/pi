import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { MAX_TASKS, THINKING_LEVELS } from "./constants.ts";

const ThinkingSchema = StringEnum(THINKING_LEVELS, {
	description: "Thinking level for this subagent run",
});

// Strict constrained-sampling providers treat every property as required
// and reject bare unions at the top level, so the schema is a flat
// `type: "object"` whose optional fields are also nullable: callers omit
// a field when the grammar allows it and send null when it does not.
// The exactly-one-mode rule is enforced at runtime in `invocationMode`.
function nullable<T extends TSchema>(schema: T, description: string) {
	return Type.Optional(Type.Union([schema, Type.Null()], { description }));
}

export const TaskSchema = Type.Object(
	{
		agent: nullable(Type.String({ minLength: 1, maxLength: 80 }), "Agent profile name; null or omit for general"),
		description: Type.String({ minLength: 1, maxLength: 80, description: "Short UI label" }),
		prompt: Type.String({ minLength: 1, maxLength: 20_000, description: "Self-contained worker briefing" }),
		cwd: nullable(
			Type.String({ minLength: 1, maxLength: 4_096 }),
			"Relative directory inside the parent working directory; null or omit to inherit it",
		),
		model: nullable(
			Type.String({ minLength: 1, maxLength: 200 }),
			"Temporary provider/model override; null or omit to inherit",
		),
		thinking: nullable(ThinkingSchema, "Thinking level override; null or omit to inherit"),
	},
	{ additionalProperties: false },
);

export const SubagentParamsSchema = Type.Object(
	{
		agent: nullable(
			Type.String({ minLength: 1, maxLength: 80 }),
			"Agent profile name for single mode; null or omit otherwise (defaults to general)",
		),
		description: nullable(
			Type.String({ minLength: 1, maxLength: 80 }),
			"Short UI label; required for single mode, null or omit otherwise",
		),
		prompt: nullable(
			Type.String({ minLength: 1, maxLength: 20_000 }),
			"Self-contained worker briefing; providing it selects single mode — null or omit when using tasks or chain",
		),
		cwd: nullable(
			Type.String({ minLength: 1, maxLength: 4_096 }),
			"Relative directory inside the parent working directory (single mode); null or omit otherwise",
		),
		model: nullable(
			Type.String({ minLength: 1, maxLength: 200 }),
			"Temporary provider/model override (single mode); null or omit otherwise",
		),
		thinking: nullable(ThinkingSchema, "Thinking level override (single mode); null or omit otherwise"),
		tasks: nullable(
			Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
			"Independent tasks run concurrently; providing it selects parallel mode — null or omit when using prompt or chain",
		),
		chain: nullable(
			Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
			"Sequential tasks where {previous} in a later prompt is replaced by the prior result; providing it selects chain mode — null or omit otherwise",
		),
	},
	{ additionalProperties: false },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type SubagentTask = Static<typeof TaskSchema>;
