/**
 * todo/constants.ts — tool identity, command name, input bounds, and prompt copy.
 */

export const TODO_TOOL_NAME = "todo";
export const TODO_TOOL_LABEL = "Todo";
export const TODOS_COMMAND_NAME = "todos";

/** Max tasks shown in a single `list` tool result body (model-facing). */
export const LIST_DISPLAY_MAX_ITEMS = 50;
export const TODO_MAX_LIST_LIMIT = LIST_DISPLAY_MAX_ITEMS;
export const TODO_MAX_LIST_QUERY_LENGTH = 200;

/** Input limits keep task snapshots and model-facing output bounded. */
export const TODO_MAX_BATCH_ITEMS = 20;
export const TODO_MAX_SUBJECT_LENGTH = 240;
export const TODO_MAX_DESCRIPTION_LENGTH = 4_000;
export const TODO_MAX_ACTIVE_FORM_LENGTH = 240;
export const TODO_MAX_OWNER_LENGTH = 160;
export const TODO_MAX_BATCH_KEY_LENGTH = 120;
export const TODO_MAX_BLOCKED_BY = 50;

/** Metadata is JSON-like, deeply copied, and bounded independently of task text. */
export const TODO_MAX_METADATA_KEY_LENGTH = 160;
export const TODO_MAX_METADATA_DEPTH = 8;
export const TODO_MAX_METADATA_ENTRIES = 100;
export const TODO_MAX_METADATA_BYTES = 16_384;

export const TODO_TOOL_DESCRIPTION = `Manage the conversation's task list for multi-step coding work.

## When to Use
- Work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift
- Capture new user requirements as tasks right away; after completing a task, add follow-up tasks discovered during implementation

## When NOT to Use
- Trivial single-step tasks and simple Q&A — just do the work

## Actions
- create: add one pending task; subject (short, imperative, reviewable scope) and description (what done means: acceptance criteria or verification detail) are required
- create_many: atomically add up to 20 pending tasks in input order; each item needs subject and description, and optional unique keys can be linked within the batch with blockedByKeys
- update: change status or details, and manage dependencies via addBlockedBy/removeBlockedBy (what this task waits on) and addBlocks/removeBlocks (what waits on this task); dependencies are validated and cycle-checked
- list: one-line summaries with unresolved blockers, optionally filtered by status, paged with limit/afterId, searched with query, or narrowed with unblockedOnly; get: one task in full; delete: tombstone an obsolete task and release its dependents; clear: requires confirm=true and the exact expectedCount, without reusing ids
- Parameters that do not apply to the chosen action are rejected with guidance

## Status Workflow
pending -> in_progress -> completed; deleted is the only terminal state. Keep exactly one task in_progress (starting one demotes any other active task): mark it in_progress BEFORE starting the work, and completed only when implementation and verification are genuinely done — never with failing tests or partial work; reopen instead of duplicating. When blocked, do not fake completion: create a task for the blocker and link it with addBlockedBy.

## Examples
{"action": "create", "subject": "Fix login redirect", "description": "Redirect lands on the dashboard; auth tests pass"}
{"action": "create_many", "items": [{"key": "parser", "subject": "Wire parser", "description": "Parser handles config"}, {"subject": "Test parser", "description": "Parser tests pass", "blockedByKeys": ["parser"]}]}
{"action": "update", "id": 2, "status": "in_progress", "activeForm": "fixing login redirect"}
{"action": "update", "id": 1, "addBlocks": [2, 3]}

## Tips
- list before create to avoid duplicates; prefer working in id order — earlier tasks usually set up context for later ones
- Use dependencies only for real ordering constraints, and delete obsolete tasks promptly so their dependents are released`;

export const TODO_PROMPT_SNIPPET = "Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift; list before creating to avoid duplicates, use create_many for a known batch of up to 20 tasks, and capture follow-up work discovered during implementation as new tasks.",
	"Mark the active `todo` task in_progress before starting work (exactly one at a time; the tool demotes any other active item) and completed immediately after verification — never while tests fail or work is partial; reopen instead of duplicating, and when blocked create a task for the blocker and link it with addBlockedBy.",
	"Keep the `todo` list short and outcome-oriented; prefer working in id order, use dependencies only for real prerequisites, and delete obsolete items promptly so their dependents are released. Clear only with confirm=true and the current expectedCount.",
];
