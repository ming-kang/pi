# plan — read-only plan mode

Adds `/plan` for a Claude-Code-style planning phase: the model explores read-only, interviews the user, and leaves the mode through a user-approved `exit_plan` tool call that saves the plan to disk and optionally compacts the context before execution starts.

## Behavior

- `/plan` (or the `--plan` CLI flag) toggles plan mode. On entry the built-in `edit`, `write`, and `bash` tools and the bundled `subagent` tool are deactivated — `subagent` because child sessions do not inherit the restricted tool set. Read-only built-ins and other extension tools (`question`, `todo`, `deepwiki`, …) stay available. A `tool_call` guard also blocks the four tools for requests already in flight when the mode toggles.
- While planning, the system prompt gains a plan-mode block: explore before asking, interview one decision at a time with the `question` tool (with a recommendation and trade-offs), skip the interview for small clear tasks, then present the full plan as response text before calling `exit_plan`.
- `exit_plan(title, plan, revises?)` opens the approval menu:
  - **Start executing (keep full context)** — saves the plan, restores tools, and execution continues in the same run.
  - **Compact context, then execute** — saves the plan, ends the run (`terminate`), compacts once the run has settled, and only then restores tools; execution restarts via a kickoff message that embeds the plan text, so continuation never depends on the compaction summary. If compaction fails, tools are restored and execution proceeds with full context.
  - **Keep planning** — optionally collects feedback (multi-line editor in the TUI, input dialog in RPC) and returns it to the model; plan mode stays active. `Esc` and dialog timeouts map here, never to an executing option.
- Both executing options save the plan file. If the session has no name yet, the plan title becomes the session name.
- `/plan` while planning exits directly without a menu or a file — the plan text is still in context. During a pending compaction the toggle is refused until the compaction settles.
- Plan files live under `<agentDir>/plans/<sessionId>/NN-<slug>.md` (`~/.pi/agent/plans/…` by default, `PI_CODING_AGENT_DIR` respected) with `title`, `created`, `cwd`, `session`, and optional `revises` frontmatter. Numbering is append-only; revisions are new files that point back via `revises`.
- To revise a plan mid-execution, re-enter with `/plan`: the system prompt lists the branch's saved plans so the model reads the latest one, accounts for completed work, and produces a revision.

## Limits

- The kickoff message embeds at most 24 000 characters of plan markdown; longer plans are truncated with a pointer to the full file.
- In `json`/`print` modes `exit_plan` cannot ask, so it saves the plan and exits with context kept (write access is restored without a menu).
- Approving with **Compact context, then execute** and then interrupting before compaction completes (quit, resume, branch switch) degrades to the keep-context exit on the next session start.

## Implementation notes

- **Conversation-backed state.** Every transition appends a `plan-mode` custom entry (never sent to the LLM); lifecycle handlers replay the current branch tail → head, so `/reload`, `/tree`, resume, and fork restore the mode. Fork and clone copy entries, so the recorded plan-file paths follow the new session even though it gets a fresh session id — the `<sessionId>` directory is only the initial storage location, not the index.
- **State is keyed per session id** (todo pattern): resume and `/tree` can switch sessions within one process, and handlers re-point the active bucket before touching state.
- **Tool restore is an inverse operation, not a snapshot.** Entry records which tools were actually removed; exit re-adds exactly those, so tools other extensions activate during planning are not revoked and tools the user had disabled are not resurrected.
- **No write access is ever needed for the plan itself** — the plan text travels as an `exit_plan` parameter and the extension writes the file.
- **The compact-then-execute window is closed by construction**: plan mode (and its tool restrictions) persists until compaction completes; the run is terminated by the tool result and the compaction starts on `agent_settled`, which fires once per fully settled run.
- The `exit_plan` result text authoritatively announces mode changes because the per-run system prompt override is not rebuilt mid-run.
