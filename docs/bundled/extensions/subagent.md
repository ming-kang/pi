# subagent — isolated foreground delegation

Adds the `subagent` tool and `/agents` settings command. It delegates bounded work to isolated in-process `AgentSession` workers; it is not a background-worker or fleet-management system.

## Tool contract

Every call supplies one ordered `tasks` array with 1–8 items:

```json
{
  "tasks": [
    {
      "prompt": "Locate the provider retry implementation and report exact symbols.",
      "agent": "explorer",
      "cwd": "src/core"
    }
  ]
}
```

Each item has:

```text
prompt   Required self-contained worker briefing
agent?   explorer or general; defaults to explorer
cwd?     Directory inside the parent working directory
```

There is no separate single-task or parallel mode. One item launches one worker; multiple items launch concurrent workers. A session-scoped gate permits at most six active workers across all sibling `subagent` calls, so additional items wait for a slot. Results always follow input order, regardless of completion order.

All tasks are preflighted before any worker starts. Profile, working-directory, model, thinking-level, or authentication failure in one item rejects the entire call without launching the other workers. Once execution begins, one worker failing does not cancel independent siblings.

Sequential work uses another `subagent` call after the parent has read the previous report and written the next briefing.

## Built-in profiles

There are exactly two profiles:

- **Explorer** (`explorer`, default): read-only investigation with `read`, `grep`, `find`, `ls`, and `bash`. Bash remains available for Git history and inspection commands such as `git log`, `git diff`, `git blame`, `git show`, `git status`, `wc`, `head`, and `tail`. Its system prompt forbids redirects, heredoc writes, temporary files, state-changing Git commands, installs, and network access.
- **General** (`general`): implementation, file changes, and stateful verification with `read`, `bash`, `edit`, and `write`.

There are no user or project profile files. Child sessions load no extensions, skills, prompt templates, or themes, so workers cannot recursively call `subagent` or inherit unrelated extension capabilities. Explorer continues to skip project context files such as `AGENTS.md`; General loads trusted project context normally.

Worker contexts are isolated, but workers share the parent's checkout. Concurrent tasks therefore must be independent and must not perform overlapping writes.

## Model and thinking selection

Model and thinking resolution has two layers:

```text
saved /agents override > current parent session
```

Callers cannot select model or thinking per task. Run `/agents` to configure Explorer or General:

1. Select **Explorer** or **General**.
2. Select **Model** or **Thinking**.
3. Choose a concrete value or **inherit**.

Each confirmed choice is saved immediately; there is no draft, Apply, or Save step. Choosing **inherit** immediately removes that override. Escape only navigates back and never rolls back choices already confirmed.

The TUI model picker supports search, scoped/all models, unavailable saved models, and catalog refresh. Thinking choices are limited to levels supported by the effective model.

Overrides are saved atomically in:

```text
~/.pi/agent/subagent.json
```

Only `explorer` and `general` keys are valid. A stale or invalid `subagent.json` (older formats, unknown profiles, or malformed JSON) is reset to an empty, fully inheriting config the first time it is loaded, so an old file never blocks the tool or `/agents`. Overrides affect future workers and never change the parent session's model or thinking level.

## Lifecycle and retry

- The parent call waits until every worker reaches a terminal state.
- Parent abort, `/reload`, `/new`, `/resume`, `/fork`, and session shutdown abort active and queued workers.
- Provider auto-retry remains visible as `Retrying (n/m) in Xs`.
- A retryable failure that produced no turns or tool use may be retried at task level up to two more times. Runs with partial work are never restarted.
- Retry backoff does not hold a concurrency slot; another queued worker can run while the failed task waits.
- A parent abort or session shutdown interrupts queued and retrying workers immediately.

Child sessions share the parent's canonical model/authentication runtime, so extension-registered providers and current credentials do not need to be mirrored into a second runtime.

## Transcript UI

The native tool title owns whole-call elapsed time. While running, the collapsed view lists one width-bounded physical row per task:

```text
● Subagent · 12s
│ › #1 Explorer · Thinking...
│ › #2 Explorer · Run git log
│ ○ #3 Explorer · Queued
│ › #4 General · Compacting...
```

`#N` is the task's stable one-based input position. Rows always remain in `#1` through `#N` order: there is no progress header, prompt excerpt, row cap, active-first reordering, or `+N more` truncation. A row reports the task's current state directly:

- `Starting...` before the worker has begun a turn;
- `Thinking...` while the model is active without a tool;
- `Read`, `Search`, `Find`, `List`, `Run`, `Edit`, or `Write` for the current tool;
- `Compacting...` during worker auto-compaction;
- `Queued` while waiting for a worker slot;
- `Retrying (n/m) in Xs` during retry backoff;
- `Completed`, `Failed`, or `Aborted`, with duration when the task started.

Long states and activities are truncated by visible terminal width, including ANSI styling and wide CJK characters, instead of wrapping onto continuation rows.

Once settled, aggregate cost joins the frozen duration in the native title, and the ordered task rows become the complete collapsed outcome summary:

```text
● Subagent · 1m 24s · $0.042
│ ✓ #1 Explorer · Completed · 48s
│ ✓ #2 Explorer · Completed · 1m 3s
│ × #3 General · Failed · 36s
│ ✓ #4 Explorer · Completed · 1m 20s
```

Zero cost is omitted. There is no separate aggregate count line; the per-task markers show the mixed outcome directly.

Expanded sections also remain in input order. Their single-line header contains only identity and compact runtime metadata:

```text
── #1 Explorer · anthropic/claude-sonnet-4-5 · medium · 3 tool uses · 2 turns · 1m 5s

Prompt
<complete original task briefing>

Activity
  Read .github/workflows/ci.yml
› Run npm test
```

The thinking level is shown as its raw value (`medium`, not `medium thinking`) and omitted when it is `off`; a non-parent working directory appears as `cwd: ...`. Per-run token, context, and cost fields are omitted from this header.

Every expanded task shows the complete original Prompt, including while the batch is still running. Active and queued tasks show bounded Activity history and retry state. A completed, failed, or aborted task immediately switches to Error/Report presentation even if sibling tasks are still active; failed or aborted workers with useful output use `Report · partial`. Streaming assistant text is not copied into the parent transcript.

Full child transcripts are not stored separately. Activity, errors, reports, usage, and model-facing output remain bounded, and completed calls restore through the parent session tree.

## Deliberate non-features

There are no custom profiles, background agents, persistent worker IDs, unread state, fleet panel, statusline widget, send/stop/resume control plane, completion notifications, chain mode, swarm/coordinator, worktree isolation, nested agents, MCP, hooks, or agent memory.
