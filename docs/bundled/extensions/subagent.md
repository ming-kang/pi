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

There are no user or project profile files. Child sessions load no extensions, skills, prompt templates, or themes, so workers cannot recursively call `subagent` or inherit unrelated extension capabilities. Both profiles load the applicable repository instructions for their working directory, including layered `AGENTS.md` or `CLAUDE.md` files. Explorer's tool set and system prompt remain strictly read-only.

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

Only `explorer` and `general` keys are valid. A malformed, unsupported, unreadable, or future-version `subagent.json` is never rewritten during load: workers temporarily inherit the parent settings and the UI reports the problem. On the first actual settings change, Pi backs up the original bytes to a collision-safe `.invalid-<timestamp>-<pid>.bak` file before writing a valid replacement; if the backup fails, the save is cancelled. Concurrent Pi processes lock, re-read, and merge profile changes before an atomic write, and no-op changes leave the file and its timestamp untouched. Overrides affect future workers and never change the parent session's model or thinking level.

## Lifecycle and retry

- The parent call waits until every worker reaches a terminal state.
- Parent abort, `/reload`, `/new`, `/resume`, `/fork`, and session shutdown abort active and queued workers.
- Provider auto-retry remains visible under the expanded task Outcome as `Retrying (n/m) in Xs`.
- A retryable failure that produced no turns or tool use may be retried at task level up to two more times. Runs with partial work are never restarted.
- Retry backoff does not hold a concurrency slot; another queued worker can run while the failed task waits.
- A parent abort or session shutdown interrupts queued and retrying workers immediately.

Child sessions share the parent's canonical model/authentication runtime, so extension-registered providers and current credentials do not need to be mirrored into a second runtime.

## Transcript UI

Pi's native tool chrome owns the aggregate `● Subagent` call marker and the dim continuation rail. The collapsed view is a compact flow containing one cell per task:

```text
● Subagent
│ ✼ #1 Explorer · ○ #2 Explorer · ✓ #3 General · × #4 General
```

`#N` is the task's stable one-based input position. Cells always remain in `#1` through `#N` order and contain only the task marker, ordinal, and profile. Running cells use the breathing dot-to-star bloom, queued cells use `○`, and completed, failed, or aborted cells use `✓`, `×`, or `■`. Wide batches wrap at cell boundaries with uniform columns. If the terminal is narrower than one complete cell, every task receives its own width-truncated row so all ordinals remain visible. Collapsed cards never expose prompts, activities, timings, token totals, costs, or failure text. Live repainting runs at 120ms only for visible collapsed blooms and at one second for expanded running durations or retry countdowns; queued, static, settled, and disposed rows keep no refresh timer.

Expanding removes aggregate Batch chrome and gives every task the same four-part layout:

```text
● Subagent
│ #1 Explorer · anthropic/claude-opus-5 · max · 99.9k tok · 60 tool calls · 12m 47s
│
│ Prompt
│   Inspect the renderer and report the exact data flow.
│
│ Activity · last 3 of 60 tool calls
│   Read(src/extensions/subagent/render.ts)
│   Grep(src/extensions/subagent)
│   Run(npm test -- test/subagent-render.test.ts)
│
│ Outcome
│   Still running...
```

The single-line task header always shows the profile, exact `provider/model` ID, raw thinking level (including `off`), cumulative provider-reported token usage, tool-call count, and task duration. Tokens use compact `k`/`M` notation with at most one decimal. The header omits working directory, turns, per-run cost, and aggregate Batch timing or cost, and truncates rather than wraps when the terminal is narrow.

Prompt contains the complete original task briefing and remains visible in every state. Prompt, Activity, and Outcome bodies use a two-column inset under their section labels.

Activity retains only the latest three actual tool calls, in execution order. Its denominator is the run's total tool-call count; small histories use `Activity · N tool calls`, and an empty history says `No tool calls yet.` Calls use compact `Read(path)`, `Grep(path)`, `Find(pattern)`, `List(path)`, `Run(command)`, `Edit(path)`, or `Write(path)` presentation. Synthetic compaction entries do not increment or occupy the tool-call history.

Outcome stays in the same position throughout the task lifecycle:

- queued or running: `Still running...`, followed by a retry countdown or active compaction state when applicable;
- completed: the worker's final Markdown report, or `No outcome returned.`;
- failed or aborted: the terminal reason, followed by `Partial outcome:` and the bounded report when useful output survived.

A terminal task exposes its Outcome immediately even while sibling tasks remain active. Profile identity, section headings, activity state markers, and outcomes use semantic theme colors; report Markdown keeps its normal Markdown palette instead of inheriting a blanket success or error color.

Full child transcripts are not stored separately. Activity, errors, reports, usage, and model-facing output remain bounded, and completed calls restore through the parent session tree.

## Deliberate non-features

There are no custom profiles, background agents, persistent worker IDs, unread state, fleet panel, statusline widget, send/stop/resume control plane, completion notifications, chain mode, swarm/coordinator, worktree isolation, nested agents, MCP, hooks, or agent memory.
