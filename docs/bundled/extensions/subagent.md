# subagent — isolated foreground delegation

Adds the `subagent` tool and `/agents` profile settings command. It delegates a bounded task to an isolated in-process `AgentSession`; it is not a background worker or a fleet manager.

## Tool modes

Exactly one mode is required per call:

- **Single**: `agent`, `description`, and `prompt`.
- **Parallel**: `tasks`, an array of independent task objects.

There is deliberately no chain mode: sequential work is driven by the parent, which reads each report before writing the next briefing.

Every task object has:

```text
agent?       Agent profile name; defaults to general
description  Short UI label
prompt       Self-contained worker briefing
cwd?         Relative or absolute directory inside the parent working directory
```

Parallel batches allow at most eight tasks. A session-scoped gate runs at most five workers concurrently, including sibling `subagent` calls from the same parent session.

## Agent profiles

Profiles are Markdown files with YAML frontmatter:

```yaml
---
name: reviewer
description: Read-only implementation reviewer
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-5
thinking: medium
backend: sdk
---

Review the delegated task independently and report exact evidence.
```

Sources and precedence are:

```text
built-in < ~/.pi/agent/agents/*.md < trusted-project/.pi/agents/*.md
```

Project definitions are loaded only after Pi trusts the project. Invalid Markdown definitions appear as `/agents` diagnostics without hiding valid profiles.

Built-in profiles:

- `general`: read, bash, edit, and write.
- `explorer`: `read`, `grep`, `find`, and `ls`, plus `bash` constrained by its system prompt to read-only inspection (git history, counting, and similar).

A profile may only allow Pi built-in tools. Child sessions load no extensions, skills, or prompt templates, so a worker cannot recursively call `subagent` or inherit unrelated extension capabilities. Project context files such as `AGENTS.md` remain available, except for the built-in `explorer`, which skips them: read-only exploration needs no commit/PR rules, and the parent interprets its results.

## Model and thinking selection

The model/thinking resolution has exactly two layers:

```text
saved /agents profile override > current parent session
```

Callers cannot pick models per call, and profile Markdown `model`/`thinking`
frontmatter is intentionally ignored: agent files travel across machines, so a
pinned model rarely exists in the reader's environment.

Run `/agents` to choose a profile. The TUI presents display-only title labels
(`explorer` becomes `Explorer`, `code-reviewer` becomes `Code Reviewer`) in
identifier order, while tool calls, profile files, and saved configuration keep
the lowercase identifier. The selected profile's human-facing description
appears below the list in full and wraps to the terminal width; built-in
profiles keep longer delegation guidance out of this UI copy.

The profile editor keeps model search and thinking selection on one screen:

- type to search configured models;
- use `Tab` to switch between scoped and all models when a scope exists;
- use the configured thinking-cycle key (`Shift+Tab` by default) to choose
  **inherit** or a level supported by the highlighted model;
- use `Enter` to save the model and thinking choice together, or `Esc` to return
  without saving.

**inherit** follows the parent session's current model or thinking value. An
explicit model is stored as `provider/model`; an explicit thinking override is
stored as its supported level.

Overrides are user-owned and saved atomically in:

```text
~/.pi/agent/subagent.json
```

They apply only to future subagent runs and never change the parent session's `/model` or thinking level.

## Lifecycle and output

- The parent tool call waits until every worker reaches a terminal state.
- Parent abort, `/reload`, `/new`, `/resume`, `/fork`, and session shutdown abort active child sessions. Queued workers do not survive the call.
- Parallel worker failures do not cancel other independent workers.
- Transient provider errors auto-retry: the worker session retries retryable stream errors with backoff (visible as a live `Retrying (n/m) in Xs…` countdown), and a failure that produced no work (for example a preflight auth throw) is rerun at the task level up to two more times. Provider and task retries share one absolute-deadline state; at zero it reads `Retrying now…`, and parent abort/session shutdown interrupts backoff immediately. Runs with partial work behind them are never rerun.
- Progress is rendered in Pi's native tool transcript. While a call is running, the Subagent renderer re-schedules its own repaint once per second, independently of worker output and the main Working spinner. Silent single and parallel runs therefore keep advancing their own elapsed clocks in collapsed and expanded views, and queued retries keep counting down. Once settled, the final duration is fixed and refresh stops.
- The collapsed view stays lean in both phases: while running, one bounded intent line (for example `Verifying changes`) carries tool uses, the `ctx:` context watermark, cost, and elapsed time above the current tool marked with `›` and the live output tail; once settled, the sentence-aware result excerpt is followed by a single metrics line (`tok · $ · duration`, plus tool uses and `ctx:` for single runs) and the configured expand hint. Live lines never quote token totals — mid-run totals are cache-inflated. The call-level status dot belongs to the tool shell; run and activity rows only use `›`, `○`, `✓`, `×`, and `■`, and parallel run rows carry stable dim ordinals that match the expanded section numbers. `Ctrl+O` expands each run into a report cover sheet: a status line, a metrics line, a fixed two-line `Prompt` preview (`… continues, N more lines`, honest about the 1KB bound), an `Activity · last n of N` digest whose successful rows are quiet aligned one-liners, a `Working` tail while streaming, and the full `Report` (or `Error`, with `Report · partial` for salvaged output) rendered as Markdown. Expanded batches start with a numbered contents list whose numbers match the `── N · ✓ Agent` section headers.
- Failed and aborted batch runs place their bounded reason on a separate error-colored line below the run headline instead of cutting it into the status row. Reasons are capped at 200 characters and keep their hanging indent when wrapped; successful settled excerpts prefer complete leading sentences within their 96-character budget. Rounded durations switch to minute form at 60 seconds without producing `1m 60s`.
- Full child transcripts are not stored separately. Bounded run details remain in the parent tool result, so completed calls restore naturally in the parent session tree.
- Nested usage is returned with the tool result and included in parent session accounting.

## Deliberate non-features

There are no background agents, persistent worker IDs, unread state, fleet panel, statusline widget, send/stop/resume control plane, completion notifications, swarm/coordinator, worktree isolation, nested agents, MCP, hooks, or agent memory.
