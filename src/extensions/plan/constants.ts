/**
 * plan/constants.ts — tool identity, command names, and prompt copy.
 *
 * Name/label/command live here so `index.ts` only assembles the extension,
 * matching the todo/question constants.ts pattern. Prompt copy is the
 * model-facing contract; keep it stable.
 */

import type { SelectOption } from "../../core/extensions/types.ts";

export const EXIT_PLAN_TOOL_NAME = "exit_plan";
export const EXIT_PLAN_TOOL_LABEL = "Exit Plan";
export const PLAN_COMMAND_NAME = "plan";
export const PLAN_FLAG_NAME = "plan";
export const PLAN_ENTRY_TYPE = "plan-mode";
export const PLAN_STATUS_KEY = "plan-mode";

/**
 * customType of the post-compaction kickoff message. Sent via sendMessage so
 * the LLM receives the full plan while the TUI renders a collapsed card.
 */
export const PLAN_KICKOFF_MESSAGE_TYPE = "plan-kickoff";

/**
 * Tools blocked while planning: edit/write grant write access directly.
 * bash stays available and is constrained to read-only inspection via the
 * plan-mode system prompt (same contract as the explorer subagent), and
 * subagent stays available but is limited to the built-in explorer profile
 * by the tool_call guard. Other extension tools (question, todo, deepwiki,
 * ...) stay available.
 */
export const PLAN_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Exploration tools activated on entry. Mirrors the explorer subagent's
 * EXPLORER_TOOLS (kept as a separate constant so plan does not depend on the
 * subagent extension): the standalone search tools plus bash for read-only
 * inspection. grep/find/ls are registered but not active in the default
 * session tool set, so plan mode must activate them explicitly.
 */
export const PLAN_EXPLORE_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash"];

/** Only subagent profile allowed while planning (read-only exploration). */
export const PLAN_ALLOWED_SUBAGENT = "explorer";

/** Name of the subagent extension tool, for the plan-mode tool_call guard. */
export const PLAN_SUBAGENT_TOOL_NAME = "subagent";

/** Max characters of plan markdown echoed into the post-compaction kickoff message. */
export const PLAN_EMBED_MAX_CHARS = 24_000;

export const MENU_EXECUTE = "Start executing";
export const MENU_COMPACT_EXECUTE = "Compact context, then execute";
export const MENU_KEEP_PLANNING = "Keep planning";

/**
 * Approval choices. The label is the decision, the description is the
 * trade-off, so the three options can be told apart without reading to the
 * end of a sentence. select() resolves to the label.
 */
export const EXIT_PLAN_MENU_OPTIONS: readonly SelectOption[] = [
	{ label: MENU_EXECUTE, description: "keep full context" },
	{ label: MENU_COMPACT_EXECUTE, description: "best for long tasks" },
	{ label: MENU_KEEP_PLANNING, description: "refine before running" },
];

/** Esc maps to "keep planning", so the dismiss hint must not read as "discard". */
export const EXIT_PLAN_CANCEL_HINT = "keep planning";

/**
 * /plan panel (shown when the command runs while planning): exit is the first
 * option, saved plans follow. Esc keeps planning with no side effects.
 */
export const PLAN_PANEL_TITLE = "Plan mode";
export const PLAN_PANEL_EXIT = "Exit plan mode";
export const PLAN_PANEL_EXIT_DESCRIPTION = "restore full tool access";
export const PLAN_PANEL_CANCEL_HINT = "keep planning";
export const PLAN_PANEL_MAX_FILES = 20;

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
- edit and write are unavailable; do not attempt changes or workarounds.
- bash is for read-only inspection only: git log/diff/blame/show/status, ls, wc, head, tail, cat, and similar. Never run anything that modifies state: no file creation or deletion, no redirect (>, >>) or heredoc writes, no temp files, no git commands that write (add, commit, checkout, restore, stash, clean), no installs, no network access.
- subagent is limited to the read-only explorer profile: always pass agent: "${PLAN_ALLOWED_SUBAGENT}"; other profiles are blocked while planning.
- Explore with read, grep, find, ls, read-only bash, and explorer subagents.

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
