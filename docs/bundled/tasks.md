# Tasks

Tasks is a built-in session capability. The `tasks` tool and `/tasks` panel inspect and control native Bash, PowerShell, and extension-owned work. Execution, retained results, and completion delivery have separate core owners; no Background extension is required.

## Start or detach work

Start Bash through the native `bash` tool (the optional native Windows `powershell` tool accepts the same fields and follows the same lifecycle):

```json
{ "command": "npm run build", "timeout": 120, "background": true }
```

Omitting `background` keeps the normal foreground wait. A background submission returns an execution reference, not a successful final outcome. `bg create` has been removed; old stored create results and background notifications still render in transcripts.

In interactive mode, **Ctrl+B** moves all eligible foreground managed tasks to the background. Once a foreground execution has run for ten seconds and can still move, the statusline shows `Ctrl+B to background`. It works even when `/tasks` owns focus. The same execution continues: no cancellation, restart or timeout reset. It does not detach ordinary file tools, or user `!` shell commands.

When nothing is eligible, the key is not consumed: it falls through to other bindings instead of reporting a no-op.

Configure `app.tasks.detach` in `keybindings.json` to change or disable the shortcut. The default `tui.editor.cursorLeft` is now `left`, freeing Ctrl+B. To restore Emacs cursor behavior, disable or rebind detach before assigning Ctrl+B to cursor-left.

Hosts can prohibit background execution with `backgroundAllowed: false`. This restriction survives runtime replacement and does not depend on task kind; foreground execution remains available.

## Management tool

`tasks` observes existing Bash, PowerShell, and extension-owned tasks:

| Action | Parameters | Behavior |
|---|---|---|
| `list` | — | Lists active and up to five retained finished records, at most 100 rows; foreground executions are omitted with a count (they deliver inline in the transcript) |
| `read` | `taskId`, optional `mode`, `bytes` | Reads bounded output/report while running or after completion |
| `wait` | `taskId`, optional `waitMs`, `sinceBytes` | Waits within a deadline and returns status plus bounded output/report |
| `kill` | `taskId` | Requests cancellation of the selected task |

Use the execution ID returned by the native tool or `tasks list`. An unknown or stale `taskId` fails with the session's current tasks listed inline (active first, then recent finishes), so the next call can use a real ID without a separate list call; an ambiguous prefix lists exactly the tasks it matched.

```json
{ "action": "read", "taskId": "<execution-id>", "mode": "tail", "bytes": 8192 }
```

Reads default to an 8KB tail. `bytes` clamps between 256 bytes and 50KB at the tool boundary (the core currently limits the actual slice to 48KB); `mode` can be `head` or `tail`. A Bash output path is included when available. Report tasks return their authoritative bounded result.

```json
{ "action": "wait", "taskId": "<execution-id>", "waitMs": 20000, "sinceBytes": 4096 }
```

`waitMs` defaults to 20 seconds and clamps between 1 and 60 seconds. Wait output is limited to 32KB, optionally starting after `sinceBytes`. Expiry or cancellation ends only the wait, not execution. Continue independent work instead of sleep-polling or repeatedly reading; wait when the next step genuinely depends on the result.

```json
{ "action": "kill", "taskId": "<execution-id>" }
```

A cancellation request is not proof that execution has stopped. The task can remain `stopping` during cleanup. Read its later terminal status for the outcome. Partial, failed, cancelled and timeout outcomes are not displayed as successful completion.

All model-facing management responses, including listings and error messages, are bounded to 50KB and 2,000 lines overall. Repeated reads do not add usage or restart execution. Completion delivery and usage accounting belong to the host, not panel refreshes.

## `/tasks` panel

The fullscreen panel lists only **ongoing tasks**, including queued, running and stopping work in both foreground (`fg`) and background (`bg`) modes. Completed tasks leave the list immediately. If the selected task finishes, its final view stays on the right until another task is selected or the panel closes. Opening the panel again does not list finished work; results remain available in the transcript and through `tasks read` / `tasks wait`.

At 100 columns or more, the left task list sits beside two independently scrollable regions: **Information** above **Output**. Narrow terminals stack the regions. The panel owns selection, focus, scrolling and cancellation; the execution module owns its information and output components:

- Bash and PowerShell show their command, directory, log path and exit code, with live plain-text output.
- Other extensions can register their own structure. A missing or failing renderer falls back to the saved task information and result text.

| Default key | Action |
|---|---|
| Left | Focus the task list |
| `i` | Focus information |
| Right / Enter | Focus output |
| Up / Down | Select a task or scroll the focused region |
| Page Up / Page Down | Page the focused list or region |
| `k`, then `y` | Request cancellation of the selected ongoing task; any other key cancels confirmation |
| Escape | Return to the list, then close |
| Ctrl+B | Detach eligible foreground executions through the host |

Shell output initially follows the tail. Scrolling up enters **browsing** and keeps a bounded output snapshot while status continues updating. Explicit downward scrolling to the bottom resumes **following**. Scrolling and closing never pause, reattach or cancel execution. Information scrolls independently, so long commands and parameters remain accessible. Task selection and each task's reading positions survive unrelated updates.

The panel polls only selected tail output once per second, up to 48 KiB per read; navigation can request an immediate refresh. A settled selected task gets a final read; browsing defers that read until following resumes. The output range describes the bounded preview, not the entire log. Selecting a task retains its result and log without delaying completion notifications. Closing releases the view, subscriptions, retention lease and timers.

Controls use `app.tasks.focusList`, `app.tasks.focusInfo`, `app.tasks.focusPreview`, `app.tasks.kill` and `app.tasks.detach`. List paging uses `tui.select.pageUp` / `pageDown`; information and output paging use `tui.editor.pageUp` / `pageDown`. All are configurable.

## Extension-owned task views

Register a `TaskViewProvider` in `session_start` with `ctx.tasks.views.register(kind, provider)`. The returned function unregisters it. Registrations belong to the current runtime and are cleared on shutdown or replacement; duplicate registrations for a kind are rejected. Native Bash and PowerShell providers are installed by the interactive host.

A provider declares `outputMode: "snapshot" | "tail"` and implements `create({ theme, requestRender })`, returning:

- `info` and `output`: TUI components whose content the panel wraps and scrolls.
- `update(task, output?)`: receives the latest detached task snapshot and, for tail providers, the bounded `TaskRead`.
- Optional `dispose()`: releases view-owned resources on selection change, provider removal or panel close.

The panel consumes navigation keys and forwards remaining keys to the focused component. Providers can request a repaint without polling or owning the execution. Use semantic theme colors. Keep log source lines unwrapped when possible so the panel can preserve their scroll anchors across resize.

An executor can publish independent, versioned display data:

```typescript
control.publishView({
  version: 1,
  data: { phase: "Scanning", findings: [{ path: "src/main.ts", count: 2 }] },
});
```

This becomes `task.viewData`. Its version and fields belong to the execution module. Only plain JSON data is accepted, with a 120 KiB storage budget and bounded nesting. Invalid or oversized data is rejected before replacing the previous value; callbacks and accessors cannot enter snapshots. The executor should publish a useful plain tool result as well, which remains readable without its provider.

On settlement, `viewData` is saved in the session JSONL's `task-result` entry. Renderers and live processes are never serialized. The existing completion projection remains separate: changing a panel view does not change tool schemas, model-facing results or notification structure. Built-in views may use the existing saved task fields and projection directly.

## Completion notifications

Interactive `task-completion` messages have a compact collapsed summary: outcome, execution kind, short ID, and a command or group brief. Failures retain a short reason; log paths, output and worker reports stay out of the collapsed view. In fullscreen mode, left-click the notification to expand or collapse that message independently. The blank spacer above it is not a click target. The configured tool-output expansion binding (default Ctrl+O) remains available for toggling output expansion across the transcript.

Expanded shell notifications separate **Command**, **Directory**, **Result** or **Error**, a bounded plain-text **Output** tail, **Log** and the full execution ID. Expanded report completions show executor-provided items and Markdown reports; failures keep their reason separate from any partial report. Each saved output/report carries an explicit truncation flag. Screen line limits are independent of source truncation, and every report item retains an allowance. These are previews of the saved bounded completion.

Rendering reads the self-contained `TaskCompletionSnapshot` in message `details`, so `/reload`, history eviction, expired logs and restart do not require a live task lookup. The session generates model-facing `content` from the same facts; `details` never enters model context or usage accounting. Commands containing `Output:`, worker reports containing headings or error-wrapper examples, and literal truncation notices remain ordinary data. See the [snapshot contract](../session-format.md#background-records).

Only the current structured completion format is specialized. Older text-only completions and malformed details receive a bounded plain **Details** view; no text reconstruction or migration is performed. Legacy `background-task` notifications keep their existing renderer. HTML export and `/tree` selector labels continue to display the saved message content.

## Lifetime

Background execution belongs to the current session runtime, not a daemon. Parent-turn cancellation still cancels foreground-owned work; after detach it does not cancel background work. Shutdown, `/reload`, `/new`, `/resume`, and `/fork` close admission, stop delivery, cancel work and perform bounded cleanup. `/tree` cancels executions whose launch anchor is absent from the destination branch and suppresses their completion delivery there; navigating back to a branch revives its undelivered completions, and ordinary conversation progress along the same branch does not cancel them. A completion already handed to the prompt queue when its run was aborted is not recalled — the next run delivers it, like any other queued message. Active processes and workers are not reattached across process restart or copied into a fork.

The panel is an observer, not a cleanup engine. Admission, bounded history/output retention, completion delivery and headless exit policy are enforced by the core service and hosting mode.

Interactive mode enables Background. Built-in print, JSON, and RPC modes and ordinary SDK sessions leave it disabled and reject `background: true`; normal foreground execution remains available. An SDK embedding can explicitly enable it via `session.bindExtensions({ tasksEnabled: true })`, but must own cancellation, bounded draining, result-driven turns, and shutdown. See [SDK Background execution](../sdk.md#background-execution).

Managed shell output is collected continuously from startup, including before detach. Background shell output is capped at 20 MiB; crossing the cap fails and stops the command. Foreground output retains its existing uncapped log behavior: detaching a command already over the background budget stops it without deleting the prior bytes. No timeout is supplied by default, and a supplied timeout remains measured from command startup, in seconds, across detach.

Managed logs are ephemeral: they are retained with the runtime record and cleaned up when that record is evicted or the runtime shuts down. Save needed output elsewhere before then. The core defaults to eight active managed executions and two independent terminal histories: 32 reports/background log tasks, plus 32 foreground log records. Report tasks count toward the first history in either mode. Foreground shell traffic can only evict older foreground shell records. Pending delivery, pins, active reads and cleanup use a separate allowance within the bounded total; pins temporarily defer history eviction, not runtime shutdown. These are service limits, not new user settings.

Terminal snapshots persist as version-2 `task-result` custom entries, including the presentation projection and optional executor-owned `viewData`; usage remains in independent version-1 `task-usage` entries. The runtime restores version-2 terminal history from the selected branch for programmatic reads, selecting the newest records independently for each history. The panel lists ongoing work only. Older result records are left in the session file and are not migrated or restored. Live execution never resumes after restart, and restoration does not replay accounting or completion events. A saved log path is not a durable attachment. See [session format](../session-format.md#background-records).

Delivered history outside the selected branch can be released and restored on return, so it does not fill the new branch's history budget. Undelivered completions stay protected while their branch is hidden. Pending delivery, pins and active reads use a separate allowance within the total runtime retention cap; restoration respects the same cap.

Completion delivery follows the same queueing path as interactive input. While the agent is running, a completion is steered into that run, so it lands right after the current tool batch — exactly like a message the user types mid-run, and behind any already queued steering. An idle session starts a completion turn instead. User preflight (input hooks, model and authentication checks, compaction) still holds delivery, so a user message is always the first thing a new run sees. One bounded completion is in flight at a time. Each execution produces one completion. A terminal `tasks wait` coordinates with automatic delivery only after its tool result is persisted: while `tasks wait` prepares a result for persistence, that task is not announced, and aborting during output reading does not lose the pending completion. Direct SDK waits remain observational until explicitly acknowledged. Plain reads and panel selection retain output without delaying notifications. Progress and repeated reads do not inject messages or add usage. `agent_settled` still describes the main agent, not the end of all background executions.

Failed completion delivery leaves the terminal result available for inspection rather than silently discarding it, and warns through the extension error channel. The next user prompt retries delivery automatically; SDK hosts can also call `session.retryTaskNotifications()` explicitly after resolving the failure. There is no infinite timer retry loop. A completion that a run emitted but never persisted, and a completion dropped by clearing the queue, fail the same way; one still sitting in the queue when its run ends stays claimed, because the next run delivers that same message.

Queued extension `nextTurn` context accompanies completion turns and stays queued until each message is persisted. A failed or partially persisted turn therefore retries only the context that has not been saved.

If an executor ignores cancellation and settles after bounded cleanup has retired its runtime or branch, the old session quarantines its bounded result and reported usage: the latest 32 records remain in memory, and persisted sessions also append `<session-file>.tasks-late.jsonl`. These audit records are excluded from active totals and are not automatically reconciled. A completed cleanup grace period is not proof that an uncooperative executor stopped.

The previous extension-owned interactive-prompt stall watchdog was not ported. Pi no longer automatically flags a prompt-looking shell tail as `waiting for input` or sends stall remediation notifications. Use non-interactive commands and inspect/stop stalled work manually; legacy stall notifications still render from saved transcripts.
