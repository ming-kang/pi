# background — background bash tasks

Adds `bg_bash`, `bg_logs`, and `bg_kill` tools plus the `/bg` command. Long-running commands (dev servers, watch builds, slow tests) run in the background while the agent keeps working; when a task ends, its status, exit code, and a tail of its output arrive automatically as a notification.

## Tools

`bg_bash` starts a command and returns immediately with a task id and output file path:

```json
{ "command": "npm run build", "timeout": 300 }
```

The optional `timeout` is in seconds; on expiry the task is killed and reported as `timeout`. The tool result only reports the start — the completion notification is the single source of truth for the outcome, so there is never a need to poll with sleep loops or repeated `bg_logs` calls.

`bg_logs` reads a bounded slice of a task's output file while it runs or after it ends:

```json
{ "taskId": "bg-3f2a91", "mode": "tail", "bytes": 8192 }
```

`mode` defaults to `tail`; `bytes` defaults to 8KB and clamps between 256 bytes and 50KB. Truncated reads state the omission up front and always include the full output path.

`bg_kill` stops a single running task by killing its whole process tree:

```json
{ "taskId": "bg-3f2a91" }
```

Killing does not bypass the normal pipeline: the task still finalizes as `killed` and its completion notification still arrives.

Task ids accept a unique prefix (with or without the `bg-` part); an ambiguous prefix is an error listing the candidates.

## Completion delivery

When a task ends, the extension sends a `background-task` notification: a small XML message carrying the task id, terminal status, exit code, runtime, output file path, and the sanitized last ~4KB of output. While the agent is streaming, the notification queues behind the current run and is delivered when the run settles; when the agent is idle, it wakes a new turn so the result is acted on immediately.

The transcript renders this notification as a one-line summary (`✓ bg-3f2a91 npm run build — completed, exit 0 in 34s`) with the output path below; expanding it shows the embedded output tail.

## /bg

`/bg` opens a two-pane overlay: the task list on the left, the selected task's live output on the right.

| Key | Action |
|---|---|
| `↑` / `↓` | Select task (resets the viewport to follow) |
| `k` | Kill the selected running task |
| `PgUp` / `PgDn` | Scroll the output viewport; `PgUp` freezes it, scrolling back to the bottom resumes following |
| `Esc` | Close |

The viewport polls the output file once per second and only ever reads the last 128KB. Outside an interactive TUI, `/bg` prints a bounded task summary instead.

## Statusline

Running and finished counts appear in the footer as `bg 2 running · 1 done`; the segment disappears when no tasks exist.

## Limits and lifecycle

- Output streams directly to a system-temp file (`pi-bg-<id>.log`), never into the project or into memory. Memory holds only a byte counter.
- Output is capped at 20MB. Hitting the cap kills the task and marks it `failed` rather than silently truncating.
- At most 8 tasks may run concurrently; `bg_bash` reports the running tasks when the limit is reached.
- Aborting the current turn (Esc) does not kill background tasks — that is what `bg_kill` and `/bg` are for.
- Session shutdown, `/reload`, new sessions, and session switches kill all running tasks; those kills are silent (no notification flood). There is no restart reattachment: finished-task records live only for the current session.
