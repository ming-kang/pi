/**
 * plan/constants.ts — tool identity, command names, and prompt copy.
 *
 * Name/label/command live here so `index.ts` only assembles the extension,
 * matching the todo/question constants.ts pattern. Prompt copy is the
 * model-facing contract; keep it stable.
 */

export const EXIT_PLAN_TOOL_NAME = "exit_plan";
export const EXIT_PLAN_TOOL_LABEL = "Exit Plan";
export const PLAN_COMMAND_NAME = "plan";
export const PLANS_COMMAND_NAME = "plans";
export const PLAN_FLAG_NAME = "plan";
export const PLAN_ENTRY_TYPE = "plan-mode";
export const PLAN_STATUS_KEY = "plan-mode";

/**
 * Tools removed while planning. edit/write/bash grant write access directly;
 * subagent spawns child sessions that do not inherit the restricted tool set,
 * so leaving it active would let the model write through a child agent.
 * Other extension tools (question, todo, deepwiki, ...) stay available.
 */
export const PLAN_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash", "subagent"]);

/** Max characters of plan markdown echoed into the post-compaction kickoff message. */
export const PLAN_EMBED_MAX_CHARS = 24_000;

export const MENU_EXECUTE = "Start executing (keep full context)";
export const MENU_COMPACT_EXECUTE = "Compact context, then execute (best for long tasks)";
export const MENU_KEEP_PLANNING = "Keep planning";

export const EXIT_PLAN_TOOL_DESCRIPTION =
	"Submit the finished plan and ask the user to approve leaving plan mode. Present the complete plan as normal response text first, then call this tool with a short title and the same plan markdown; on approval the plan is saved to disk. The user chooses between executing with full context, compacting the context before executing, or continuing to plan. Only available while plan mode is active.";

export const EXIT_PLAN_PROMPT_SNIPPET = "Submit the finished plan for user approval and leave plan mode";

export const EXIT_PLAN_PROMPT_GUIDELINES = [
	"Call `exit_plan` only after presenting the complete plan as response text; make it the only tool call in that step and stop after it returns.",
	"`exit_plan` results are authoritative for plan-mode state: follow them even when the plan-mode system prompt block is still present later in the run.",
];

const PLAN_MODE_PROMPT = `[PLAN MODE]
You are in plan mode: a read-only phase for exploring the codebase and agreeing on a plan with the user before any changes are made.

Restrictions:
- edit, write, bash, and subagent are unavailable; do not attempt changes or workarounds. Explore with read, grep, find, and ls instead.

Working style:
- Answer questions from the code, not from the user: explore before asking.
- When product intent, scope, or risk tolerance is unclear, interview the user with the question tool. Focus on one decision per exchange (batch only tightly coupled decisions) and always include your recommendation and the trade-offs.
- Skip the interview for small, clear tasks. Pick sensible defaults for low-risk details and state them in the plan.

Delivering the plan:
- When the plan is ready, present it in full as normal response text (goal, steps, verification criteria) so the user can read it, then call exit_plan with a short title and the same markdown as the plan parameter.
- The exit_plan tool result is authoritative for mode state: this block can outlive plan mode within a run, so if the result says plan mode has ended, it has ended.`;

/** Build the plan-mode system prompt block, listing plans already saved for this branch. */
export function buildPlanModePrompt(planFiles: string[]): string {
	if (!planFiles.length) return PLAN_MODE_PROMPT;
	const listing = planFiles.map((path) => `- ${path}`).join("\n");
	return `${PLAN_MODE_PROMPT}

Plans already saved for this session (read them with the read tool):
${listing}
When revising a saved plan, read the latest one first, account for work already completed, and produce a revision that states what changed and why; set the revises parameter to the file name of the plan being revised.`;
}
