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

export const SubagentParamsSchema = Type.Union([
	Type.Object(
		{
			agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
			description: Type.String({ minLength: 1, maxLength: 80 }),
			prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
			cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
			model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			thinking: Type.Optional(ThinkingSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			chain: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
		},
		{ additionalProperties: false },
	),
]);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type SubagentTask = Static<typeof TaskSchema>;
