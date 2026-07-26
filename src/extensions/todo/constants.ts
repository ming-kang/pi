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

export const TODO_TOOL_DESCRIPTION =
	"Manage the conversation's task list for multi-step coding work. Actions: create, update, list, get, delete, clear. Tasks are created pending and are short, outcome-oriented units (imperative subjects, reviewable scope) with pending/in_progress/completed status and optional blockedBy dependencies (validated, cycle-checked); deleting a task releases its dependents and leaves an immutable tombstone available to get/list. Keep exactly one task in_progress: mark it before starting work, and mark it completed only when implementation and verification are genuinely done — never with failing tests or partial work; reopen a task instead of duplicating it. Use for work with three or more meaningful steps or user-provided task lists; skip it for trivial single-step tasks and simple Q&A.";

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift; mark the active task in_progress before working on it and completed immediately after verification.",
	"Keep exactly one `todo` item in_progress at a time (the tool demotes any other active item to pending); never mark completed while tests fail, verification has not run, or work is partial — reopen instead of duplicating.",
	"Keep the `todo` list short and outcome-oriented; use blockedBy only for real prerequisites, and delete obsolete items promptly so their dependents are released.",
];
