/**
 * todo/constants.ts — tool identity, command name, input bounds, and prompt copy.
 */

export const TODO_TOOL_NAME = "todo";
export const TODO_TOOL_LABEL = "Todo";
export const TODOS_COMMAND_NAME = "todos";

/** Hard capacity of the task list and of a single create/delete batch. */
export const TODO_MAX_ITEMS = 20;
export const TODO_MAX_BATCH_ITEMS = 20;

/** Input limits keep task snapshots and model-facing output bounded. */
export const TODO_MAX_SUBJECT_LENGTH = 160;
export const TODO_MAX_DESCRIPTION_LENGTH = 500;

export const TODO_TOOL_DESCRIPTION = `Manage the conversation's task list for multi-step coding work.

## When to Use
- Work with three or more meaningful steps, a user-provided task list, or a long session where progress can drift
- Capture new user requirements as tasks right away; after completing a task, add follow-up tasks discovered during implementation

## When NOT to Use
- Trivial single-step tasks and simple Q&A — just do the work

## Actions
- create: atomically add one or many pending tasks from the ordered items array (1 to 20 items); each item needs a short imperative subject and a description of what done means
- update: edit one task by id — subject, description, or status; all transitions and reopens are allowed
- list: show every remaining task with its description, active first
- delete: remove obsolete tasks by ids (1 to 20, duplicates ignored)
- The current list holds at most 20 tasks; parameters that do not apply to the chosen action are rejected

## Status Workflow
pending -> in_progress -> completed. Keep exactly one task in_progress: marking one active demotes any other active task to pending. Mark a task in_progress BEFORE starting the work, and completed only when its description is satisfied and relevant checks pass; never with failing tests or partial work. Reopen instead of duplicating. When blocked, do not fake completion: return the task to pending, create a task for the blocker, and finish the blocker first.

## Examples
{"action": "create", "items": [{"subject": "Wire parser", "description": "Parser handles the config format"}, {"subject": "Test parser", "description": "Parser tests pass"}]}
{"action": "update", "id": 2, "status": "in_progress"}
{"action": "update", "id": 2, "status": "completed", "description": "Parser verified against config fixtures"}
{"action": "delete", "ids": [3]}

## Tips
- list before create to avoid duplicates; prefer working in id order — earlier tasks usually set up context for later ones
- delete obsolete tasks promptly so the list stays short and accurate`;

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift; list first when tasks may already exist, and create one or many tasks with the ordered items array.",
	"Keep exactly one `todo` task in_progress: mark it in_progress before starting work and completed only after verification — never while tests fail or work is partial; reopen instead of duplicating, and when blocked leave the `todo` task pending and create a task for the blocker.",
	"Keep the `todo` list short and outcome-oriented; prefer working in id order and delete obsolete `todo` items promptly.",
];
