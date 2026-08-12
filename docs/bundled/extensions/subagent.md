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

There is no separate single-task or parallel mode. One item launches one worker; multiple items launch concurrent workers. A session-scoped gate permits at most five active workers across all sibling `subagent` calls, so additional items wait for a slot. Results always follow input order, regardless of completion order.

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

Only `explorer` and `general` keys are valid. Overrides affect future workers and never change the parent session's model or thinking level.

## Lifecycle and retry

- The parent call waits until every worker reaches a terminal state.
- Parent abort, `/reload`, `/new`, `/resume`, `/fork`, and session shutdown abort active and queued workers.
- Provider auto-retry remains visible as `Retrying (n/m) in Xs`.
- A retryable failure that produced no turns or tool use may be retried at task level up to two more times. Runs with partial work are never restarted.
- Retry backoff does not hold a concurrency slot; another queued worker can run while the failed task waits.
- A parent abort or session shutdown interrupts queued and retrying workers immediately.

Child sessions share the parent's canonical model/authentication runtime, so extension-registered providers and current credentials do not need to be mirrored into a second runtime.

## Transcript UI

While running, the collapsed view shows aggregate progress followed by at most four stable task rows:

```text
2/4 complete · 1 running · 1 queued · 12s
› #1 Explorer · Locate retry scheduling — Run git log
✓ #2 Explorer · Map provider registration
○ #3 Explorer · Find related tests
○ #4 General  · Apply focused fix
```

Expanded running calls show profile/model/thinking/cwd metrics, retry state, and the bounded Activity history for each task. Streaming assistant text is not copied into the parent transcript.

Once settled, the collapsed view contains only the aggregate result, cost, and duration:

```text
3 completed · 1 failed · 24s · $0.031
```

The expanded settled view shows, for each task:

- the complete original Prompt from the tool call;
- model, thinking, cwd, usage, cost, and duration;
- Error when present;
- the final Report, or `Report · partial` when a failed/aborted worker produced useful output.

Activity is intentionally a running-state view; settled transparency comes from the original Prompt and final Report. Full child transcripts are not stored separately. Activity, errors, reports, usage, and model-facing output remain bounded, and completed calls restore through the parent session tree.

## Deliberate non-features

There are no custom profiles, background agents, persistent worker IDs, unread state, fleet panel, statusline widget, send/stop/resume control plane, completion notifications, chain mode, swarm/coordinator, worktree isolation, nested agents, MCP, hooks, or agent memory.
