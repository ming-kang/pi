# todo — task list overlay

Adds a `todo` tool plus `/todos` for multi-step work, with a live overlay above the editor.

## Behavior

- Actions: `create`, `create_many`, `update`, `list`, `get`, `delete`, `clear`. Statuses: `pending`, `in_progress`, `completed`, `deleted`. `create_many` atomically creates up to 20 pending tasks in input order (all-or-nothing); every item needs a `subject` and `description`, and unique batch `key` values let `blockedByKeys` name prerequisites in the same batch. `list` accepts an optional `status` filter and `includeDeleted`; `status: "deleted"` includes tombstones directly. It also supports `limit`/`afterId` pagination, a case-insensitive subject/description `query`, and `unblockedOnly` for tasks with no unresolved dependencies. Parameters that do not apply to the chosen action are rejected with guidance (for example `blockedBy` on `update` points at `addBlockedBy`/`removeBlockedBy`) instead of being silently ignored.
- The live overlay renders above the editor and hides itself when there are no visible tasks.
- Creation always starts a task as `pending` and requires both `subject` and `description` (what done means); `blockedBy` dependencies are supported for sequencing, and missing dependencies, deleted dependencies, self-dependencies, and cycles are rejected. A task cannot move to `in_progress` or `completed` until every `blockedBy` dependency is `completed`. If a new unresolved dependency blocks an active task, it is automatically moved to `pending` and named in the tool result.
- `update` manages both edge directions: `addBlockedBy`/`removeBlockedBy` change what the task waits on, `addBlocks`/`removeBlocks` change what waits on it (stored as the targets' `blockedBy`, with the same validation and cycle checks). An empty string removes `description`, `activeForm`, or `owner`; `metadata` merges with `null` deleting keys.
- `list` lines show only unresolved blockers plus the task's `@owner`; full `blockedBy`/`blocks` detail lives in `get`. `/todos` uses the same 50-task display bound and directs longer lists to paged `todo list` calls.
- Deletion — via `delete` or `update` with `status: "deleted"` — leaves an immutable tombstone for branch history, removes that task from every dependent `blockedBy` list, and therefore releases dependents; the tool result names pending dependents that ended up fully unblocked. A deletion cannot be combined with other field edits in the same call. `clear` requires `confirm: true` and an `expectedCount` equal to the current task count, then empties the list without reusing ids.
- Newly completed tasks remain visible for 30 seconds, then drop from the overlay; historical completions loaded by `/reload` or `/tree` stay hidden so live work remains prominent.
- **Exactly one `in_progress`.** Moving a task to `in_progress` auto-demotes any other `in_progress` tasks to `pending`; the tool result lists demoted ids so the model sees the side effect.
- **Verification soft nudge.** When a completion leaves the list fully done with 3+ completed tasks and no subject/description matching `verif|test|check|review`, the tool result appends a short NOTE (text only — `details` schema unchanged).

## Limits

- `list` output is bounded at 50 items by default; `limit` accepts 1–50, and a paged result includes its next `afterId` when truncated.
- Task input is bounded: subjects and active forms are limited to 240 characters, descriptions to 4,000, owners to 160, batch keys to 120, and dependency lists to 50 entries. List queries are limited to 200 characters.
- `metadata` is a bounded JSON-like object: 8 levels deep, 100 entries, 160-character keys, and 16 KiB total UTF-8 payload.
- The overlay body is capped at 10 rows; its truncation summary includes hidden status counts.
- Newly completed tasks remain visible for 30 seconds then drop from the overlay.

## Implementation notes

- **Conversation-backed state.** Every tool result stores a schema-versioned full snapshot in `details`; lifecycle handlers replay the current branch on `/reload`, compaction, and session-tree navigation. There is no separate disk database. Compaction-safe by design: `sessionManager.getBranch()` returns the full branch history — only `buildSessionContext` summarizes for the LLM. Replay walks the branch **tail → head** to find the latest valid snapshot, accepting compatible unversioned history while rejecting malformed or unsupported versioned details.
- **State is keyed per session id.** Resume and `/tree` can switch sessions within one process; `execute` and the lifecycle handlers re-point the active bucket before touching state.
- **Status transitions are gated.** `completed` can be reopened to `in_progress` or `pending`, but a `deleted` tombstone is terminal. Single-active is enforced on demote (not hard-reject) so the model does not need a retry loop.
- **Tool execution is sequential** (`executionMode: "sequential"`) so parallel tool calls cannot race on in-memory state. Validation failures **throw** so Pi marks `isError: true` and the branch replays the last good snapshot.
- **Overlay paint is pure + width-cached.** Completion visibility bookkeeping runs in `update()` plus a disposable timeout, never during `render`. Same terminal width reuses the last line array.
