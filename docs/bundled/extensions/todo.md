# todo — compact task list

Adds a `todo` tool and `/todos` command for multi-step work. While unfinished tasks exist, a width-aware one-line widget stays above the editor; `/todos` shows the complete list on demand.

## Tool actions

The tool has four actions:

- `create` atomically adds one or more pending tasks from a single ordered `items` array. Each item requires a concise `subject` and a `description` of what done means.
- `update` changes one task's `subject`, `description`, or `status`.
- `list` returns every current task and its full description.
- `delete` removes one or more task IDs from the current list.

Single and batch creation use the same shape:

```json
{
  "action": "create",
  "items": [
    {
      "subject": "Implement config parsing",
      "description": "Valid config is parsed and invalid config is rejected"
    },
    {
      "subject": "Verify config parsing",
      "description": "Focused parser tests pass"
    }
  ]
}
```

Tasks have three statuses: `pending`, `in_progress`, and `completed`. Creation always starts at `pending`. `update` requires an ID and at least one replacement field; subjects and descriptions remain non-empty. Exactly one task may be `in_progress`; activating another automatically returns the previous active task to `pending` and reports that side effect. Any status can be reopened or corrected. `list` includes every task, ordered as active, pending by ID, then completed by ID.

Todo v2 intentionally has no dependency graph, owner, metadata, active-form label, tombstone, filtering, pagination, `get`, or `clear`. Keep tasks in intended execution order. When work is blocked, return it to `pending`, create a task that resolves the blocker, and activate that task instead.

`create` and `delete` are atomic: invalid input or a missing deletion ID leaves the list unchanged. Deletion removes an item from the current snapshot without reusing its ID. Older conversation branches still contain their earlier snapshots.

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

Consecutive tool calls collapse into the native `todo` transcript group. Collapsed settled rows use result-aware v2 details to show actual created IDs and subjects, update status and automatic demotion, list counts, or deleted IDs. Expanding restores the complete call and native result: a created batch lists each task's ID, subject, and indented description, and a settled deletion names every removed task's ID and subject. Malformed or older details fall back to a bounded call summary.

## Limits

- At most 20 current tasks, including completed tasks.
- At most 20 items in one `create` or IDs in one `delete`.
- Subjects are limited to 160 characters.
- Descriptions are limited to 500 characters.
- Subject and description whitespace is normalized to one line.
- Model-facing list output is bounded by those limits; no pagination is needed.

Delete completed or obsolete tasks before the list reaches capacity; `create` past the limit fails with an error that names that remedy.

## Storage and replay

Todo state is conversation-backed rather than stored in a separate database. Every successful tool result carries a full v2 snapshot:

```ts
{
  schemaVersion: 2,
  change: { /* create, update, list, or delete */ },
  state: {
    items: [/* complete current list */],
    nextId: 7
  }
}
```

The assistant tool call already stores the arguments, so result details do not duplicate `params` or `action`. The extension keeps one closure-scoped store for its runtime and replays the latest valid v2 snapshot from the current conversation branch on session start and `/tree` navigation. `/reload`, resume, and session replacement create a fresh extension runtime and replay that branch. Compaction does not require a separate replay handler because it does not change the live branch state.

Replay scans tail to head, validates the bounded state, and can fall back past a malformed v2 snapshot. Todo v1 snapshots are intentionally ignored and are not migrated; their historical tool-result text remains in the session transcript.

Tool execution is sequential, so concurrent calls cannot race on the closure store. Validation failures throw before commit, allowing Pi to mark the result as an error while the previous snapshot remains authoritative.
