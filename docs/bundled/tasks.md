# Tasks

Tasks is a built-in session capability. The `tasks` tool and `/tasks` panel inspect and control native Bash, PowerShell, and extension-owned work. Execution, retained results, and completion delivery have separate core owners; no Background extension is required.

## Start or detach work

Start Bash through the native `bash` tool (the optional native Windows `powershell` tool accepts the same fields and follows the same lifecycle):

```json
{ "command": "npm run build", "timeout": 120, "background": true }
```

Omitting `background` keeps the normal foreground wait. A background submission returns an execution reference, not a successful final outcome. Up to eight background executions run at once; a ninth background submission is rejected without starting. Foreground commands are never limited by background work. `bg create` has been removed; its old stored results and background notifications show their saved text in transcripts.

In interactive mode, **Ctrl+B** moves eligible foreground managed tasks to the background, oldest first, while background slots remain; when every slot is taken it says so instead. Once a foreground execution has run for ten seconds and can still move, the statusline shows `Ctrl+B to background`. It works even when `/tasks` owns focus. The same execution continues: no cancellation, restart or timeout reset. It does not detach ordinary file tools, or user `!` shell commands.

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

Reads default to an 8KB tail. `bytes` clamps between 256 bytes and 48KB; `mode` can be `head` or `tail`. A Bash output path is included when available. Tasks without a log return their bounded published result. Every read and wait reports the byte range it returned and where to continue, for example `bytes 92160–100352 of 100352 · next sinceBytes 100352`.

```json
{ "action": "wait", "taskId": "<execution-id>", "waitMs": 20000, "sinceBytes": 4096 }
```

`waitMs` defaults to 20 seconds and clamps between 1 and 60 seconds. Wait output is limited to 32KB, optionally starting after `sinceBytes`. When more than 32KB was written after `sinceBytes`, the wait returns the newest 32KB and reports how many bytes it skipped. Expiry or cancellation ends only the wait, not execution. Continue independent work instead of sleep-polling or repeatedly reading; wait when the next step genuinely depends on the result.

```json
{ "action": "kill", "taskId": "<execution-id>" }
```

A cancellation request is not proof that execution has stopped. The task can remain `stopping` during cleanup. Read its later terminal status for the outcome. Partial, failed, cancelled and timeout outcomes are not displayed as successful completion.

All model-facing management responses, including listings and error messages, are bounded to 50KB and 2,000 lines overall. Repeated reads do not add usage or restart execution. Completion delivery and usage accounting belong to the host, not panel refreshes.

## `/tasks` panel

The fullscreen panel has one scrollable list. **Active** groups queued, running and stopping work; **Finished** groups all retained results on the selected branch, including foreground shell results, newest first. Empty groups are hidden. Task summaries show status and elapsed time; foreground/background mode is available in Details. The background action is offered only when the selected task can move.

Selection follows the task when it finishes; new work does not steal focus or replace browsed output. The list preserves the selected row's screen position where space permits. Reopening remembers the selected ID and right-hand tab while the runtime remains available. Runtime replacement resets these preferences, and branch navigation removes results outside the visible branch. History remains bounded by the retention limits below.

At 100 columns or more, the task list sits beside an inspector. **Output** shows the result directly; **Details** holds the full command, directory, task ID, log location and executor-specific details. Each task and tab keeps its reading position for the lifetime of the panel. Tab switches between the two panes, preserving the right-hand tab. Left/Right switch Output/Details only when the inspector has focus.

The focused pane has a highlighted border. Task selection uses a persistent row background, and the selected right-hand tab uses an underline; neither changes when focus moves. When the system theme has no background colors, the selected row uses inverse text. There are no focus arrows or extra title colors. Narrow terminals show one pane at full width with the same Tab navigation and no focus highlight. The inspector includes task context when the list is hidden. Escape closes the panel from either pane. The minimum supported size is 60 columns by 14 rows.

Bash and PowerShell show live plain-text output. Other executors show their published result, and a task without a command is labeled by its title. Missing logs fall back to the saved result. Task status, failure reasons and output-read errors remain distinct.

| Default key | Action |
|---|---|
| `/` | Locate any retained task by title, command, kind or ID; Up/Down choose a candidate, Enter or clicking locates it and restores the full list, Escape restores the prior selection and focus |
| Left / Right | Output / Details, only while the inspector has focus |
| Tab / Shift+Tab | Switch between list and inspector, preserving the current tab |
| Up / Down | Select a task or scroll the focused region |
| Page Up / Page Down | Page the focused list or region |
| Home / End | Top / bottom of the list or bounded preview |
| `f` | Follow the latest output, or load the final output after completion, while Output has focus |
| `b` | Move only the selected eligible foreground task to the background |
| `k`, then Enter | Request cancellation of the selected whole task; Escape cancels confirmation. Confirmation has no time limit and closes if its target finishes |
| `?` | Show configurable controls; Up/Down scroll the help |
| Escape | Close the current search, help or confirmation first; otherwise close the panel |
| Ctrl+B | Detach **all** eligible foreground executions through the host |

Click a pane to focus it, a task row to select it, or a tab label to display it. The mouse wheel scrolls the pane under the pointer without changing keyboard focus or task selection. Search, help and confirmation consume their own input without activating the panel behind them.

Shell output initially follows the tail, marked **Live** next to the output. Scrolling up enters **Browsing**, which holds a bounded output snapshot while status continues updating. In Output, press `f`, End, or scroll down to the bottom to resume following. If the task finishes while browsing, the panel offers to load its final output. Closing or scrolling never pauses, restarts or cancels execution.

The panel polls only selected tail output once per second, up to 48 KiB per read; navigation and settlement can request an immediate refresh. Progress updates and animation do not add log reads. A truncated tail shows its preview and total byte counts; ordinary complete output omits these statistics. Empty output and expired logs have explicit messages; an unavailable log falls back to the saved result when available. Selecting a task retains its result and log without delaying completion notifications. Closing releases subscriptions, the retention lease and timers.

Controls use the `app.tasks.*` bindings: `search`, `previousTab`, `nextTab`, `nextFocus`, `previousFocus`, `top`, `bottom`, `follow`, `kill`, `confirmStop`, `detachSelected`, `detach` and `help`. List paging uses `tui.select.pageUp` / `pageDown`; Details and Output paging use `tui.editor.pageUp` / `pageDown`. All are configurable. The former view and direct-focus bindings have been removed.

The statusline counts all active managed work and points to `/tasks`. When only retained background results remain, it labels that scope explicitly. The model-facing `tasks list` keeps its background-only scope and foreground omission count.

## Completion notifications

Interactive `task-completion` messages have a compact collapsed summary: outcome, execution kind, duration, short ID, and the command or, without one, the task title. Failures retain a short reason; log paths, output and worker reports stay out of the collapsed view. In fullscreen mode, left-click the notification to expand or collapse that message independently. The blank spacer above it is not a click target. The configured tool-output expansion binding (default Ctrl+O) remains available for toggling output expansion across the transcript.

Expanded notifications separate **Command** (or **Task** for a titled task), **Directory**, **Result** or **Error** with the recorded exit code, a bounded plain-text **Output** tail, **Log** and the full execution ID. The saved output keeps the end of the result, where the outcome is, and carries an explicit truncation flag. Screen line limits are independent of source truncation. These are previews of the saved bounded completion.

Rendering reads the self-contained `TaskCompletionSnapshot` in message `details`, so `/reload`, history eviction, expired logs and restart do not require a live task lookup. The session generates model-facing `content` from the same facts; `details` never enters model context or usage accounting. Commands containing `Output:` and literal truncation notices remain ordinary data. See the [snapshot contract](../session-format.md#background-records).

Only the current structured completion format (version 2) is specialized. Older completions, including version-1 shell and report completions, and malformed details receive a bounded plain **Details** view of their saved message; no text reconstruction or migration is performed. Legacy `background-task` notifications show as plain messages. HTML export and `/tree` selector labels continue to display the saved message content.

## Lifetime

Background execution belongs to the current session runtime, not a daemon. Parent-turn cancellation still cancels foreground-owned work; after detach it does not cancel background work. Shutdown, `/reload`, `/new`, `/resume`, and `/fork` close admission, stop delivery, cancel work and perform bounded cleanup. `/tree` cancels executions whose launch anchor is absent from the destination branch and suppresses their completion delivery there. Results are saved on their launch branch, so interactive `/tree` first lists those running tasks and asks before stopping them; navigating back to a branch revives its undelivered completions, and ordinary conversation progress along the same branch does not cancel them. A completion already handed to the prompt queue when its run was aborted is not recalled — the next run delivers it, like any other queued message. Active processes and workers are not reattached across process restart or copied into a fork.

The panel is an observer, not a cleanup engine. Admission, bounded history/output retention, completion delivery and headless exit policy are enforced by the core service and hosting mode.

Interactive mode enables Background. Built-in print, JSON, and RPC modes and ordinary SDK sessions leave it disabled and reject `background: true`; normal foreground execution remains available. An SDK embedding can explicitly enable it via `session.bindExtensions({ tasksEnabled: true })`, but must own cancellation, bounded draining, result-driven turns, and shutdown. See [SDK Background execution](../sdk.md#background-execution).

Managed shell output is collected continuously from startup, including before detach. Background shell output is capped at 20 MiB; crossing the cap fails and stops the command. Foreground output retains its existing uncapped log behavior: detaching a command already over the background budget stops it without deleting the prior bytes. No timeout is supplied by default, and a supplied timeout remains measured from command startup, in seconds, across detach.

Managed logs are ephemeral: they are retained with the runtime record and cleaned up when that record is evicted or the runtime shuts down. Save needed output elsewhere before then. The core defaults to eight concurrent background executions and two independent terminal histories: 32 background results plus 32 foreground results. Foreground work of any kind can only evict older foreground records. Pending delivery, pins, active reads and cleanup use a separate allowance within the bounded total; pins temporarily defer history eviction, not runtime shutdown. These are service limits, not new user settings.

Terminal snapshots persist as version-2 `task-result` custom entries; usage remains in independent version-1 `task-usage` entries. A foreground snapshot omits its output, which the transcript already saves in the tool result, and restoration reads it back from there. The runtime restores version-2 terminal history from the selected branch for programmatic reads and the panel's Finished group, selecting the newest records independently for each history. Older result records are left in the session file and are not migrated or restored. Live execution never resumes after restart, and restoration does not replay accounting or completion events. Restored records drop their log path: logs never outlive the runtime that wrote them. See [session format](../session-format.md#background-records).

Delivered history outside the selected branch can be released and restored on return, so it does not fill the new branch's history budget. Undelivered completions stay protected while their branch is hidden. Pending delivery, pins and active reads use a separate allowance within the total runtime retention cap; restoration respects the same cap.

Completion delivery follows the same queueing path as interactive input. While the agent is running, a completion is steered into that run, so it lands right after the current tool batch — exactly like a message the user types mid-run, and behind any already queued steering. An idle session starts a completion turn instead. User preflight (input hooks, model and authentication checks, compaction) still holds delivery, so a user message is always the first thing a new run sees. One bounded completion is in flight at a time. Each execution produces one completion. A terminal `tasks wait` coordinates with automatic delivery only after its tool result is persisted: while `tasks wait` prepares a result for persistence, that task is not announced, and aborting during output reading does not lose the pending completion. Direct SDK waits remain observational until explicitly acknowledged. Plain reads and panel selection retain output without delaying notifications. Progress and repeated reads do not inject messages or add usage. `agent_settled` still describes the main agent, not the end of all background executions.

Failed completion delivery leaves the terminal result available for inspection rather than silently discarding it, and warns through the extension error channel. The next user prompt retries delivery automatically; SDK hosts can also call `session.retryTaskNotifications()` explicitly after resolving the failure. There is no infinite timer retry loop. A completion that a run emitted but never persisted, and a completion dropped by clearing the queue, fail the same way; one still sitting in the queue when its run ends stays claimed, because the next run delivers that same message.

Queued extension `nextTurn` context accompanies completion turns and stays queued until each message is persisted. A failed or partially persisted turn therefore retries only the context that has not been saved.

If an executor ignores cancellation and settles after bounded cleanup has retired its runtime or branch, the old session quarantines its bounded result and reported usage: the latest 32 records remain in memory, and persisted sessions also append `<session-file>.tasks-late.jsonl`. These audit records are excluded from active totals and are not automatically reconciled. A completed cleanup grace period is not proof that an uncooperative executor stopped.

The previous extension-owned interactive-prompt stall watchdog was not ported. Pi no longer automatically flags a prompt-looking shell tail as `waiting for input` or sends stall remediation notifications. Use non-interactive commands and inspect/stop stalled work manually; legacy stall notifications show as plain saved messages.
