# Background tasks and groups

The `background` extension provides the `bg` management tool and `/bg` panel. The session's core Background service owns execution, cancellation, output, history and completion delivery. The extension does not launch commands or run a second task registry.

## Start or detach work

Start Bash through the native `bash` tool (the optional native Windows `powershell` tool accepts the same fields and follows the same lifecycle):

```json
{ "command": "npm run build", "timeout": 120, "background": true }
```

Start a whole Subagent invocation through its native tool:

```json
{
  "background": true,
  "tasks": [{ "agent": "explorer", "prompt": "Inspect the build configuration and report findings." }]
}
```

Omitting `background` keeps the normal foreground wait. A background submission returns an execution reference, not a successful final outcome. `bg create` has been removed; old stored create results and background notifications still render in transcripts.

In interactive mode, **Ctrl+B** moves all eligible foreground shell tasks and Subagent invocations to the background. It works even when `/bg` owns focus. The same execution continues: no cancellation, restart, new worker or timeout reset. It does not detach individual workers, ordinary file tools, or user `!` shell commands.

If nothing is eligible, Pi reports:

> No foreground Bash or Subagent execution can be moved to the background.

Configure `app.backgroundTasks.detach` in `keybindings.json` to change or disable the shortcut. The default `tui.editor.cursorLeft` is now `left`, freeing Ctrl+B. To restore Emacs cursor behavior, disable or rebind detach before assigning Ctrl+B to cursor-left.

Workers cannot start background work themselves. Their system prompt forbids it and the host-assigned worker role rejects `background: true` before command startup; the shared schema remains unchanged. Foreground commands still work. Workers have no `bg` tool and must not bypass the restriction with shell detachment. Only the parent agent or user can background the whole Subagent invocation.

## Management tool

`bg` observes existing Bash tasks and whole Subagent groups:

| Action | Parameters | Behavior |
|---|---|---|
| `list` | — | Lists active and up to five retained finished records, at most 100 rows |
| `read` | `taskId`, optional `mode`, `bytes` | Reads bounded output/report while running or after completion |
| `wait` | `taskId`, optional `waitMs`, `sinceBytes` | Waits within a deadline and returns status plus bounded output/report |
| `kill` | `taskId` | Requests cancellation of the Bash task or entire Subagent group |

Use the execution ID returned by the native tool or `bg list`. Worker IDs are display identities, not independent management targets.

```json
{ "action": "read", "taskId": "<execution-id>", "mode": "tail", "bytes": 8192 }
```

Reads default to an 8KB tail. `bytes` clamps between 256 bytes and 50KB at the tool boundary (the core currently limits the actual slice to 48KB); `mode` can be `head` or `tail`. A Bash output path is included when available. Subagent reads use the authoritative bounded report rather than raw worker transcripts.

```json
{ "action": "wait", "taskId": "<execution-id>", "waitMs": 20000, "sinceBytes": 4096 }
```

`waitMs` defaults to 20 seconds and clamps between 1 and 60 seconds. Wait output is limited to 32KB, optionally starting after `sinceBytes`. Expiry or cancellation ends only the wait, not execution. Continue independent work instead of sleep-polling or repeatedly reading; wait when the next step genuinely depends on the result.

```json
{ "action": "kill", "taskId": "<execution-id>" }
```

A cancellation request is not proof that execution has stopped. The task can remain `stopping` during cleanup. Read its later terminal status for the outcome. Partial, failed, cancelled and timeout outcomes are not displayed as successful completion.

All model-facing management responses, including listings and error messages, are bounded to 50KB and 2,000 lines overall. Repeated reads do not add usage or restart execution. Completion delivery and usage accounting belong to the host, not panel refreshes.

## `/bg` panel

The inline panel replaces the editor without hiding the transcript. Terminals at least 110 columns wide show a list beside the selected preview, inside one rounded border with a central divider; narrower terminals show the focused pane. The active pane title is accented; an inactive selected row retains a muted selection marker. The panel stays compact (at most 20 rows), leaving room for the transcript.

- Bash rows and Subagent group/worker rows retain stable selection as status and ordering change.
- Foreground/background mode is explicit on group rows.
- Worker detail shows identity/profile, group, model, usage, Prompt, Activity and Outcome from the public projection.
- Opening a view does not reattach the parent wait. Closing it never kills execution.
- Selected groups are pinned against history eviction until selection changes or the panel closes.
- Completed detail stays open. The panel releases its subscriptions, pin and timers on close or session shutdown.

| Default key | Action |
|---|---|
| Left / Right | Focus the list / selected preview (also on narrow terminals) |
| Up / Down | Select a row in the list; scroll the focused preview |
| Enter | Focus/open preview |
| Page Up / Page Down | Page the focused list or preview independently |
| `k` | Request cancellation of the selected task or whole group, including when a worker is selected |
| Escape | Return from detail, then close |
| Ctrl+B | Detach eligible foreground executions through the host |

Preview positions are retained per row while the panel is open, including across focus changes, updates and resizes. Worker previews start at the top. Shell previews initially follow the tail; scrolling up switches to **browsing**, and only explicit downward scrolling to the bottom resumes **following**. Neither mode pauses execution. Range counters describe the visible rows/lines within the bounded preview, not the entire log. Metadata stays above the scrolling content; on very short terminals, status and diagnostics take priority over other metadata.

Controls follow `app.backgroundTasks.focusList`, `app.backgroundTasks.focusPreview`, `tui.select.*`, `app.backgroundTasks.kill`, and `app.backgroundTasks.detach`. List paging uses `tui.select.pageUp`/`pageDown`; preview paging uses `tui.editor.pageUp`/`pageDown`, so the two can be rebound independently. Theme colors are semantic. Only visible selected output is read, at most once per second and within a 128KB request budget (the service may impose a smaller bound), with at most 2,000 viewport lines. Settled output is read once. Unselected work continues collecting progress independently of the panel.

Outside TUI mode, `/bg` sends a bounded summary through the host notification UI rather than mounting a component (print/JSON notification UI is a no-op). Whether background startup is supported is an explicit host capability; a panel is never required for execution.

## Completion notifications

Interactive `background-completion` messages have a compact collapsed summary: outcome, execution kind, short ID, and a command or group brief. Failures retain a short reason; log paths, output and worker reports stay out of the collapsed view. In fullscreen mode, left-click the notification to expand or collapse that message independently. The blank spacer above it is not a click target. The configured tool-output expansion binding (default Ctrl+O) remains available for toggling output expansion across the transcript.

Expanded shell notifications separate **Command**, **Result** or **Error**, a bounded plain-text **Output** tail, **Log** and the full execution ID. Expanded Subagent completions show numbered worker profiles and statuses, a short description when useful, and Markdown **Report** sections; failures distinguish the error from any partial report instead of repeating the generated prompt-heading wrapper. Long metadata wraps, visual output is bounded, and source truncation notices remain visible. These are previews of the saved bounded completion, not live log readers.

Rendering uses only the persisted message text and optional task ID, so saved notifications remain readable after `/reload`, history eviction or restart without looking up a running task. Unrecognized, ambiguous or incomplete saved formats use a neutral, bounded **Details** view rather than guessing worker boundaries or showing the default raw custom-message card. The stored content, model-facing completion, delivery and usage accounting are unchanged. Legacy `background-task` notifications keep their existing renderer. This presentation applies to the interactive transcript; it does not change HTML export or `/tree` selector labels.

## Lifetime

Background execution belongs to the current session runtime, not a daemon. Parent-turn cancellation still cancels foreground-owned work; after detach it does not cancel background work. Shutdown, `/reload`, `/new`, `/resume`, and `/fork` close admission, stop delivery, cancel work and perform bounded cleanup. `/tree` cancels executions whose launch anchor is absent from the destination branch and suppresses their completion delivery there; ordinary conversation progress along the same branch does not cancel them. Active processes and workers are not reattached across process restart or copied into a fork.

The panel is an observer, not a cleanup engine. Admission, bounded history/output retention, completion delivery and headless exit policy are enforced by the core service and hosting mode.

Interactive mode enables Background. Built-in print, JSON, and RPC modes and ordinary SDK sessions leave it disabled and reject `background: true`; normal foreground execution remains available. An SDK embedding can explicitly enable it via `session.bindExtensions({ backgroundEnabled: true })`, but must own cancellation, bounded draining, result-driven turns, and shutdown. See [SDK Background execution](../../sdk.md#background-execution).

Managed shell output is collected continuously from startup, including before detach. Background shell output is capped at 20 MiB; crossing the cap fails and stops the command. Foreground output retains its existing uncapped log behavior: detaching a command already over the background budget stops it without deleting the prior bytes. No timeout is supplied by default, and a supplied timeout remains measured from command startup, in seconds, across detach.

Managed logs are ephemeral: they are retained with the runtime record and cleaned up when that record is evicted or the runtime shuts down. Save needed output elsewhere before then. The core defaults to eight active managed executions, with bounded terminal history (32 records plus a separate bounded pending-notification allowance); pins temporarily defer history eviction, not runtime shutdown. These are service limits, not new user settings.

Terminal bounded text snapshots persist as `background-task-result` custom entries, and usage as independent `background-usage` entries. A saved log path is not a durable attachment. `/bg` restores bounded terminal history from the selected branch's valid saved snapshots. This is observation only: live execution never resumes after restart, and restoration does not replay accounting or completion events. See [session format](../../session-format.md#background-records).

Completion delivery waits for a safe idle boundary, respects queued user work, and sends one bounded completion at a time. A Subagent group produces one summary, not a separate wake-up per worker. A terminal `bg wait` coordinates with automatic delivery only after its tool result is persisted; aborting during output reading does not lose the pending completion. Direct SDK waits remain observational until explicitly acknowledged. Progress and repeated reads do not inject messages or add usage. `agent_settled` still describes the main agent, not the end of all background executions.

Failed completion delivery leaves the terminal result available for inspection rather than silently discarding it. SDK hosts can explicitly call `session.retryBackgroundNotifications()` after resolving the failure; there is no infinite timer retry loop.

If an executor ignores cancellation and settles after bounded cleanup has retired its runtime or branch, the old session quarantines its bounded result and reported usage: the latest 32 records remain in memory, and persisted sessions also append `<session-file>.background-late.jsonl`. These audit records are excluded from active totals and are not automatically reconciled. A completed cleanup grace period is not proof that an uncooperative executor stopped.

The previous extension-owned interactive-prompt stall watchdog was not ported. Pi no longer automatically flags a prompt-looking shell tail as `waiting for input` or sends stall remediation notifications. Use non-interactive commands and inspect/stop stalled work manually; legacy stall notifications still render from saved transcripts.
