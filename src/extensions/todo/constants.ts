/**
 * todo/constants.ts — tool identity, command name, and prompt copy.
 *
 * Name/label/command live here so `index.ts` only assembles the tool, matching
 * the question/deepwiki constants.ts pattern. Prompt copy is the model-facing
 * contract; keep it stable.
 */

export const TODO_TOOL_NAME = "todo";
export const TODO_TOOL_LABEL = "Todo";
export const TODOS_COMMAND_NAME = "todos";

/** Max tasks shown in a single `list` tool result body (model-facing). */
export const LIST_DISPLAY_MAX_ITEMS = 50;

export const TODO_TOOL_DESCRIPTION = `Manage the conversation's task list for multi-step coding work.

## When to Use
- Work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift
- Capture new user requirements as tasks right away; after completing a task, add follow-up tasks discovered during implementation

## When NOT to Use
- Trivial single-step tasks and simple Q&A — just do the work

## Actions
- create: add a pending task; subject (short, imperative, reviewable scope) and description (what done means: acceptance criteria or verification detail) are required
- update: change status or details, and manage dependencies via addBlockedBy/removeBlockedBy (what this task waits on) and addBlocks/removeBlocks (what waits on this task); dependencies are validated and cycle-checked
- list: one-line summaries with unresolved blockers, optionally filtered by status; get: one task in full; delete: tombstone an obsolete task and release its dependents; clear: drop the list without reusing ids
- Parameters that do not apply to the chosen action are rejected with guidance

## Status Workflow
pending -> in_progress -> completed; deleted is the only terminal state. Keep exactly one task in_progress (starting one demotes any other active task): mark it in_progress BEFORE starting the work, and completed only when implementation and verification are genuinely done — never with failing tests or partial work; reopen instead of duplicating. When blocked, do not fake completion: create a task for the blocker and link it with addBlockedBy.

## Examples
{"action": "create", "subject": "Fix login redirect", "description": "Redirect lands on the dashboard; auth tests pass"}
{"action": "update", "id": 2, "status": "in_progress", "activeForm": "fixing login redirect"}
{"action": "update", "id": 1, "addBlocks": [2, 3]}

## Tips
- list before create to avoid duplicates; prefer working in id order — earlier tasks usually set up context for later ones
- Use dependencies only for real ordering constraints, and delete obsolete tasks promptly so their dependents are released`;

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift; list before creating to avoid duplicates, and capture follow-up work discovered during implementation as new tasks.",
	"Mark the active `todo` task in_progress before starting work (exactly one at a time; the tool demotes any other active item) and completed immediately after verification — never while tests fail or work is partial; reopen instead of duplicating, and when blocked create a task for the blocker and link it with addBlockedBy.",
	"Keep the `todo` list short and outcome-oriented; prefer working in id order, use dependencies only for real prerequisites, and delete obsolete items promptly so their dependents are released.",
];
