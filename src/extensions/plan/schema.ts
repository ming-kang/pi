import { type Static, Type } from "typebox";

export const ExitPlanParamsSchema = Type.Object({
	title: Type.String({
		description: "Short plan title. Used for the plan file name and, when the session is unnamed, the session name.",
	}),
	plan: Type.String({
		description: "The complete plan as markdown: goal, steps, and verification criteria.",
	}),
	revises: Type.Optional(
		Type.String({
			description: "File name of a previously saved plan this plan revises, e.g. `01-add-cache.md`.",
		}),
	),
});

export type ExitPlanParams = Static<typeof ExitPlanParamsSchema>;

export type ExitPlanDecision = "execute" | "compactAndExecute" | "keepPlanning" | "cancelled";

export interface ExitPlanDetails {
	decision: ExitPlanDecision;
	title: string;
	/** Absolute path of the saved plan file. Present for both execute decisions. */
	planPath?: string;
}

/** details of the post-compaction kickoff custom message. */
export interface PlanKickoffDetails {
	title: string;
	planPath: string;
}
