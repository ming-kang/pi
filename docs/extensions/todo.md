# todo — task list overlay

Adds a `todo` tool plus `/todos` for multi-step work, with a live overlay above the editor.

## Behavior

- Actions: `create`, `update`, `list`, `get`, `delete`, `clear`. Statuses: `pending`, `in_progress`, `completed`, `deleted`. `list` accepts an optional `status` filter and `includeDeleted`; `status: "deleted"` includes tombstones directly.
- The live overlay renders above the editor and hides itself when there are no visible tasks.
- Creation always starts a task as `pending`; `blockedBy` dependencies are supported for sequencing, and missing dependencies, deleted dependencies, self-dependencies, and cycles are rejected. A task cannot move to `in_progress` or `completed` until every `blockedBy` dependency is `completed`.
- Deletion — via `delete` or `update` with `status: "deleted"` — leaves an immutable tombstone for branch history, removes that task from every dependent `blockedBy` list, and therefore releases dependents. `clear` empties the list without reusing ids.
- Newly completed tasks remain visible for 30 seconds, then drop from the overlay; historical completions loaded by `/reload` or `/tree` stay hidden so live work remains prominent.
- **Exactly one `in_progress`.** Moving a task to `in_progress` auto-demotes any other `in_progress` tasks to `pending`; the tool result lists demoted ids so the model sees the side effect.
- **Verification soft nudge.** When a completion leaves the list fully done with 3+ completed tasks and no subject/description matching `verif|test|check|review`, the tool result appends a short NOTE (text only — `details` schema unchanged).

## Limits

- `list` output is bounded at 50 items by default, with a trailing notice when truncated.
- The overlay body is capped at 10 rows; its truncation summary includes hidden status counts.
- Newly completed tasks remain visible for 30 seconds then drop from the overlay.

## Implementation notes

- **Conversation-backed state.** Every tool result stores a full snapshot in `details`; lifecycle handlers replay the current branch on `/reload`, compaction, and session-tree navigation. There is no separate disk database. Compaction-safe by design: `sessionManager.getBranch()` returns the full branch history — only `buildSessionContext` summarizes for the LLM. Replay walks the branch **tail → head** and stops at the latest todo `toolResult`.
- **State is keyed per session id.** Resume and `/tree` can switch sessions within one process; `execute` and the lifecycle handlers re-point the active bucket before touching state.
- **Status transitions are gated.** `completed` can be reopened to `in_progress` or `pending`, but a `deleted` tombstone is terminal. Single-active is enforced on demote (not hard-reject) so the model does not need a retry loop.
- **Tool execution is sequential** (`executionMode: "sequential"`) so parallel tool calls cannot race on in-memory state. Validation failures **throw** so Pi marks `isError: true` and the branch replays the last good snapshot.
- **Overlay paint is pure + width-cached.** Completion visibility bookkeeping runs in `update()` plus a disposable timeout, never during `render`. Same terminal width reuses the last line array.

**Files:**

- `index.ts` — tool + `/todos` command, lifecycle handlers, render
- `constants.ts` — tool/command identity and model-facing prompt copy
- `schema.ts` — params, status/action types, details shape, and empty state
- `state.ts` — mutation engine (`applyTodoMutation`), transition rules, cycle check, reverse branch replay
- `view.ts` — overlay/list formatting, status marks and colors
- `overlay.ts` — the live `TodoOverlay` widget (visibility bookkeeping + width-cached render)
