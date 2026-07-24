# subagent — isolated foreground delegation

Adds the `subagent` tool and `/agents` profile settings command. It delegates a bounded task to an isolated in-process `AgentSession`; it is not a background worker or a fleet manager.

## Tool modes

Exactly one mode is required per call:

- **Single**: `agent`, `description`, and `prompt`.
- **Parallel**: `tasks`, an array of independent task objects.
- **Chain**: `chain`, an array of sequential task objects. `{previous}` in a later prompt is replaced by the previous worker's bounded final response.

Every task object has:

```text
agent?       Agent profile name; defaults to general
description  Short UI label
prompt       Self-contained worker briefing
cwd?         Relative directory inside the parent working directory
model?       Temporary provider/model override
thinking?    Temporary thinking-level override
```

Parallel and chain batches allow at most eight tasks. A session-scoped gate runs at most three workers concurrently, including sibling `subagent` calls from the same parent session.

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

- `general`: read, bash, edit, write, grep, find, and ls.
- `explorer`: read-only `read`, `grep`, `find`, and `ls`, with low thinking by default.

A profile may only allow Pi built-in tools. Child sessions load no extensions, skills, or prompt templates, so a worker cannot recursively call `subagent` or inherit unrelated extension capabilities. Project context files such as `AGENTS.md` remain available.

## Model and thinking selection

The model/thinking resolution order is:

```text
per-call tool fields
  > saved /agents profile override
  > profile Markdown frontmatter
  > current parent session
```

Run `/agents` to choose a profile and set either field to:

- **inherit**: force the active parent-session value;
- **agent default**: clear the saved override and use Markdown/default inheritance;
- a configured `provider/model` or explicit supported thinking level.

Overrides are user-owned and saved atomically in:

```text
~/.pi/agent/subagent.json
```

They apply only to future subagent runs and never change the parent session's `/model` or thinking level.

## Lifecycle and output

- The parent tool call waits until every worker reaches a terminal state.
- Parent abort, `/reload`, `/new`, `/resume`, `/fork`, and session shutdown abort active child sessions. Queued workers do not survive the call.
- Parallel worker failures do not cancel other independent workers. A failed or aborted chain step skips its remaining steps.
- Progress is rendered in Pi's native tool transcript. The collapsed view shows status, recent activity, usage, and the configured expand hint; `Ctrl+O` shows bounded activities and final Markdown reports.
- Full child transcripts are not stored separately. Bounded run details remain in the parent tool result, so completed calls restore naturally in the parent session tree.
- Nested usage is returned with the tool result and included in parent session accounting.

## Deliberate non-features

There are no background agents, persistent worker IDs, unread state, fleet panel, statusline widget, send/stop/resume control plane, completion notifications, swarm/coordinator, worktree isolation, nested agents, MCP, hooks, or agent memory.

**Files:** `packages/coding-agent/src/extensions/subagent/`

- `index.ts` — registration, parent provider synchronization, `/agents`, shutdown cleanup
- `agents.ts` / `settings.ts` / `resolve.ts` — profile discovery, persistent overrides, task validation
- `sdk-runner.ts` / `runner.ts` — isolated sessions, progress, abort, concurrency, modes
- `activity.ts` / `render.ts` — bounded evidence, usage, native transcript rendering
- `schema.ts` / `types.ts` / `constants.ts` — public tool contract and data model
