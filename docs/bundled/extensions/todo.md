# todo — compact task list

Adds a `todo` tool and `/todos` command for multi-step work. While unfinished tasks exist, a width-aware one-line widget stays above the editor; `/todos` shows the complete list on demand.

## Tool patches

One call applies one patch built from three optional groups:

- `create` atomically adds one or more tasks in input order. Each item requires a concise `subject` and a `description` of what done means; `status` defaults to `pending` and may be set explicitly, including `in_progress`.
- `update` edits one or more tasks by `id`. Blank or omitted `subject`/`description` fields keep the current values, so a status-only edit is `{"update": [{"id": 2, "status": "completed"}]}`.
- `delete` removes one or more task IDs. Deleting an ID that is already absent is a recorded no-op, not an error.

Omit or leave empty any group the call does not need; calling with `{}` lists every task with its full description:

```json
{
  "create": [
    {
      "subject": "Implement config parsing",
      "description": "Valid config is parsed and invalid config is rejected",
      "status": "in_progress"
    },
    {
      "subject": "Verify config parsing",
      "description": "Focused parser tests pass"
    }
  ]
}
```

```json
{ "update": [{ "id": 1, "status": "completed" }, { "id": 2, "status": "in_progress" }] }
```

```json
{ "delete": [3] }
```

Tasks have three statuses: `pending`, `in_progress`, and `completed`. Exactly one task may be `in_progress`; one activation per call returns every other active task to `pending` and reports that side effect, while a call that tries to activate two tasks is rejected as a real contradiction. Any status can be reopened or corrected. Listing includes every task, ordered as active, pending by ID, then completed by ID.

Todo intentionally has no action discriminator, dependency graph, owner, metadata, active-form label, tombstone, filtering, pagination, `get`, or `clear`. Keep tasks in intended execution order. When work is blocked, return it to `pending`, create a task that resolves the blocker, and activate that task instead.

The whole patch is validated before anything is applied: invalid input leaves the list unchanged. Within one call, `delete` applies before `update` and `create`, so a same-call deletion frees capacity for the creation. A task cannot be edited twice or be both edited and deleted in one call. Deletion removes an item from the current snapshot without reusing its ID. Older conversation branches still contain their earlier snapshots.

## Presentation

The persistent widget displays only subjects:

```text
Todos 2/6 · [>] #4 Fix login redirect  [ ] #5 Add regression tests  +4 more (2 pending, 2 completed)
```

`2/6` means completed tasks over total tasks. The active task is shown first, followed by pending tasks in ID order. Completed tasks are represented by the count and overflow summary, not individual segments. As width shrinks, complete pending segments move into `+N more`; the active subject is truncated only after the detailed overflow has fallen back to its short form. The renderer always returns at most one terminal-width-safe line.

The widget is registered only while a `pending` or `in_progress` task exists. It disappears immediately for an empty or fully completed list; there is no completion timer or visibility cache.

`/todos` shows every task with its description on an indented second line:

```text
Todos: 1 in progress, 3 pending, 2 completed
[>] #4 Fix login redirect
    Login reaches the dashboard and focused tests pass
[ ] #5 Add regression tests
    Cover invalid redirects and session restoration
```

Consecutive tool calls collapse into the native `todo` transcript group. Collapsed settled rows use result-aware details to show actual created IDs and subjects, update status and automatic demotion, list counts, deleted IDs, and auto-removed completed tasks. Expanding restores the complete call and native result: a created batch lists each task's ID, subject, and indented description, and a settled deletion names every removed task's ID and subject plus any IDs that were already absent. Malformed or older details fall back to a bounded call summary.

## Limits

- At most 20 current tasks. When a call would push the list past 20, the oldest completed tasks are removed automatically to make room — except tasks that same call created or updated; if nothing else can be reclaimed, the call is rejected.
- At most 20 items in one `create`, `update`, or `delete` group.
- Subjects are limited to 160 characters.
- Descriptions are limited to 500 characters.
- Subject and description whitespace is normalized to one line.
- Model-facing list output is bounded by those limits; no pagination is needed.

## Storage and replay

Todo state is conversation-backed rather than stored in a separate database. Every successful tool result carries a full snapshot:

```ts
{
  schemaVersion: 3,
  change: {
    created: [/* new task ids */],
    updated: [/* { id, from, to } status transitions */],
    deleted: [/* { id, subject } */],
    absent: [/* delete ids already gone */],
    evicted: [/* completed tasks auto-removed for capacity */],
    demotedId: 5 /* only when an activation demoted another task */
  },
  state: {
    items: [/* complete current list */],
    nextId: 7
  }
}
```

The assistant tool call already stores the arguments, so result details do not duplicate the patch parameters. The extension keeps one closure-scoped store for its runtime and replays the latest valid v3 snapshot from the current conversation branch on session start and `/tree` navigation. `/reload`, resume, and session replacement create a fresh extension runtime and replay that branch. Compaction does not require a separate replay handler because it does not change the live branch state.

Replay scans tail to head, validates the bounded state, and can fall back past a malformed v3 snapshot. Snapshots from older schema versions (v1/v2) are intentionally ignored and are not migrated: restoring a conversation written before v3 starts with an empty list, while the historical tool-result text remains in the session transcript.

Tool execution is sequential, so concurrent calls cannot race on the closure store. Validation failures throw before commit, allowing Pi to mark the result as an error while the previous snapshot remains authoritative.
