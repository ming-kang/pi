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

// Mechanism plus the cross-field rules TodoParamsSchema cannot state (total
// capacity with automatic reclaim, the single-in_progress rule, atomicity).
// Per-parameter bounds and wording live in the schema. The single-in_progress
// rule is stated in both places on purpose: it is the invariant models break
// most often.
export const TODO_TOOL_DESCRIPTION = `Manage the conversation's task list for multi-step coding work. One call applies a patch: create adds tasks (status defaults to pending), update edits tasks by id (blank or omitted fields are kept), delete removes tasks by id. Omit or leave empty any group you do not need; call with {} to list every task with its description. At most one task may be in_progress: setting one demotes the others. The list holds 20 tasks; when full, the oldest completed tasks are removed automatically, except tasks created or updated in this call. Delete existing tasks in the same patch to free space; an id cannot be both updated and deleted. A call that fails validation leaves the list unchanged.

{"create": [{"subject": "Wire parser", "description": "Parser handles the config format", "status": "in_progress"}]}
{"update": [{"id": 1, "status": "completed"}, {"id": 2, "status": "in_progress"}]}
{"delete": [3]}`;

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, for user-provided task lists, and in long sessions where progress can drift; skip it for trivial single-step tasks and simple Q&A.",
	"Mark the `todo` task you are working on in_progress before starting, and completed only after its description is satisfied. Leave no task in_progress when waiting or when all work is done.",
	"When blocked, leave the `todo` task pending and create a task for the blocker instead of faking completion.",
	"Keep the `todo` list short: list before create to avoid duplicates, work in id order, and delete obsolete tasks promptly.",
];
