import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { MAX_TASKS, THINKING_LEVELS } from "./constants.ts";

const ThinkingSchema = StringEnum(THINKING_LEVELS, {
	description: "Thinking level for this subagent run",
});

export const TaskSchema = Type.Object(
	{
		agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
		description: Type.String({ minLength: 1, maxLength: 80 }),
		prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
		cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
		model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		thinking: Type.Optional(ThinkingSchema),
	},
	{ additionalProperties: false },
);

// Providers commonly require tool parameter schemas to be a top-level
// `type: "object"`, so the three invocation modes are optional fields with
// the exactly-one-mode rule enforced at runtime in `invocationMode`.
export const SubagentParamsSchema = Type.Object(
	{
		agent: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 80,
				description: "Agent profile name for single mode; defaults to general",
			}),
		),
		description: Type.Optional(
			Type.String({ minLength: 1, maxLength: 80, description: "Short UI label; required for single mode" }),
		),
		prompt: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 20_000,
				description: "Self-contained worker briefing; providing it selects single mode",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 4_096,
				description: "Relative directory inside the parent working directory (single mode)",
			}),
		),
		model: Type.Optional(
			Type.String({ minLength: 1, maxLength: 200, description: "Temporary provider/model override (single mode)" }),
		),
		thinking: Type.Optional(ThinkingSchema),
		tasks: Type.Optional(
			Type.Array(TaskSchema, {
				minItems: 1,
				maxItems: MAX_TASKS,
				description: "Independent tasks run concurrently; providing it selects parallel mode",
			}),
		),
		chain: Type.Optional(
			Type.Array(TaskSchema, {
				minItems: 1,
				maxItems: MAX_TASKS,
				description: "Sequential tasks; {previous} in a later prompt is replaced by the prior result",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type SubagentTask = Static<typeof TaskSchema>;
