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

export const TODO_TOOL_DESCRIPTION = `Manage the conversation's task list for multi-step coding work. create atomically adds 1-20 pending tasks from the ordered items array, each needing a short imperative subject and a description of what done means; update edits one task by id (subject, description, or status, at least one required); list returns every remaining task with its description, active first; delete removes 1-20 tasks by ids (duplicates ignored, every id must exist). The list holds at most 20 tasks including completed ones, and ids are never reused. Status is pending, in_progress, or completed; exactly one task may be in_progress, so setting one demotes any other active task to pending. Any transition is allowed, including reopening a completed task. Parameters that do not apply to the chosen action are rejected, and invalid input leaves the list unchanged.

{"action": "create", "items": [{"subject": "Wire parser", "description": "Parser handles the config format"}, {"subject": "Test parser", "description": "Parser tests pass"}]}
{"action": "update", "id": 2, "status": "in_progress"}
{"action": "update", "id": 2, "status": "completed", "description": "Parser verified against config fixtures"}
{"action": "delete", "ids": [3]}`;

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, for user-provided task lists, and in long sessions where progress can drift; skip it for trivial single-step tasks and simple Q&A.",
	"Keep exactly one `todo` task in_progress: mark it before starting the work, and completed only after its description is satisfied — never while tests fail or work is partial.",
	"When blocked, leave the `todo` task pending and create a task for the blocker instead of faking completion.",
	"Keep the `todo` list short: list before create to avoid duplicates, work in id order, and delete obsolete tasks promptly.",
];
