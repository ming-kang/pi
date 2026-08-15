# background — background bash tasks

Adds the `bg` tool (actions: `create`, `read`, `wait`, `kill`, `list`) plus the `/bg` command. Long-running commands (dev servers, watch builds, slow tests) run in the background while the agent keeps working; when a task ends, its status, exit code, and a tail of its output arrive automatically as a notification.

## Tool

All five operations share one tool. Every call sets `action`; the remaining parameters belong to that action.

### create

Starts a command in the background and returns immediately with a task id and an output file path:

```json
{ "action": "create", "command": "npm run build", "description": "build", "timeout": 300 }
```

- `description` is a short model-written label (e.g. `dev server`) shown in `/bg`, task listings, and the completion notification.
- `timeout` is in seconds; on expiry the task is killed and reported as `timeout`.
- The command runs detached — appending `&` is never needed and would lose exit-code tracking.

The tool result only reports the start. The completion notification is the single source of truth for the outcome, so there is never a need to poll with sleep loops or repeated reads.

### read

Reads a bounded slice of a task's output file while it runs or after it ends:

```json
{ "action": "read", "taskId": "bg-3f2a91", "mode": "tail", "bytes": 8192 }
```

`mode` defaults to `tail`; `bytes` defaults to 8KB and clamps between 256 bytes and 50KB. Truncated reads state the omission up front and always include the full output path; reads of a running task say `still running`. The output file is a plain file — the built-in read tool also works on it for line-based paging.

### wait

Blocks until a task finishes, within a bound:

```json
{ "action": "wait", "taskId": "bg-3f2a91", "waitMs": 20000, "sinceBytes": 4096 }
```

- `waitMs` defaults to 20000 and clamps between 1000 and 60000.
- `sinceBytes` (taken from a previous read/wait result) restricts the returned output to what was written after that offset; without it the last 32KB is returned. Offsets past EOF (for example after output truncation) fall back to the tail and say so.

If the task finishes within the window, the result is delivered inline — status, exit code, runtime, and the bounded output delta — and the followUp notification is suppressed, so the completion is delivered exactly once. If the window expires, the result says the task is still running, includes a small tail peek so progress stays visible, and the notification fires later as usual. This is the only sanctioned way to wait; sleeping to emulate it is never correct.

### kill

Stops a single running task by killing its whole process tree:

```json
{ "action": "kill", "taskId": "bg-3f2a91" }
```

Killing does not bypass the normal pipeline: the task still finalizes as `killed` and its completion is delivered wherever it was awaited — inline via `wait`, or as the notification otherwise.

### list

Lists currently known tasks — running tasks first, then the five most recently finished, with any overflow folded into a trailing note:

```json
{ "action": "list" }
```

Task ids accept a unique prefix (with or without the `bg-` part); an ambiguous prefix is an error listing the candidates.

## Completion delivery

When a task ends, the extension sends a `background-task` notification: a small XML message carrying the task id, terminal status, exit code, runtime, output file path, the optional description, and the sanitized last ~4KB of output. While the agent is streaming, the notification queues behind the current run and is delivered when the run settles; when the agent is idle, it wakes a new turn so the result is acted on immediately.

The transcript renders this notification as a one-line summary (`✓ bg-3f2a91 npm run build — completed, exit 0 in 34s`; with a description: `✓ bg-3f2a91 dev server (npm run build) — completed, exit 0 in 34s`) with the output file's name below; expanding it shows the full output path and the embedded output tail.

## /bg

`/bg` opens an inline task menu in the editor slot (like `/model`); the chat transcript stays visible above it. The list shows each task's status glyph, id, duration, and label (the description over the first command line); `Enter` opens the selected task's live output view, which replaces the menu.

| Key | In the task list | In the output view |
|---|---|---|
| `↑` / `↓` | Select task | Scroll one line (freezes following) |
| `Enter` | Open the selected task's output | — |
| `k` | Kill the selected running task | Kill the viewed task |
| `PgUp` / `PgDn` | — | Scroll a page; `PgUp` freezes following, scrolling back to the bottom resumes it |
| `Esc` | Close the menu | Back to the task list |

While a `bg wait` call is pending, its transcript row refreshes once per second (`bg wait bg-3f · waiting 12s/20s · +3.2KB new output`) until the result settles. The task list separates running tasks from finished ones with a `── finished ──` divider and adapts its visible rows to short terminal windows. The output view polls the output file once per second and only ever reads the last 128KB — and only when the task's output actually grew; a finished task's output is read once. Outside an interactive TUI, `/bg` prints a bounded task summary instead.

## Statusline

Running and finished counts appear in the footer as `bg 2 running · 1 done`; tasks the stall watchdog has flagged are reported separately as `bg 2 running · 1 waiting for input · 1 done` (flagged tasks are running tasks, so the counts add up); the segment disappears when no tasks exist.

## Limits and lifecycle

- Background tasks inherit the session's `PI_*` environment variables (`PI_SESSION_ID`, `PI_MODEL`, …) just like the built-in bash tool, snapshotted when the task starts.
- Tasks run through the session's configured shell (`shellPath`) and honor `shellCommandPrefix`, matching the built-in bash tool. The prefix is applied at execution time only — it never appears in task labels or notifications.
- Output streams directly to a system-temp file (`pi-bg-<id>.log`), never into the project or into memory. Memory holds only a byte counter.
- Output is capped at 20MB. Hitting the cap kills the task and marks it `failed` rather than silently truncating.
- At most 8 tasks may run concurrently; `create` reports the running tasks when the limit is reached.
- Aborting the current turn (Esc) does not kill background tasks — that is what `kill` and `/bg` are for.
- Session shutdown, `/reload`, new sessions, and session switches kill all running tasks; those kills are silent (no notification flood). There is no restart reattachment: finished-task records live only for the current session.
- Output files outlive the session for later inspection (the `read` action and notifications keep pointing at them); Pi never deletes them automatically — the system temp directory's own cleanup policy applies.
