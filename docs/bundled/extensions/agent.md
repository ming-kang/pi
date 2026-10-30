# Agent — lightweight delegation

The bundled `Agent` extension adds the `Agent` tool and `/agent` settings command. One call delegates one self-contained coding task to a temporary Agent and returns its final report. There are no General/Explore profiles, batch arrays, persistent worker identities, or chain modes.

## Tool contract

```json
{
  "description": "Inspect Tasks persistence",
  "prompt": "Trace task-result restoration and report the relevant paths and invariants. Do not edit files.",
  "background": false
}
```

- `prompt` is required, must be self-contained, and is limited to 16 KiB. The Agent cannot see the parent conversation.
- `description` is an optional short label for the Transcript and `/tasks`; otherwise Pi derives one from the prompt.
- `background` is optional. Foreground waits for the report; `true` returns a Task ID after initialization and delivers the report automatically. Interactive **Ctrl+B** can detach a foreground call without restarting it.

Issue parallel `Agent` calls for independent work. Each call is a separate Transcript row and Task, including its own completion notification; there is no aggregate batch view. At most four Agents run concurrently in one extension runtime, with additional calls queued visibly in Tasks. Parallel tasks must not perform overlapping writes.

Agents use the parent's working directory and share its canonical model/authentication runtime. Their isolated in-memory sessions have `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, load applicable repository instructions, and do not load extensions, skills, prompt templates, or themes. They cannot recursively delegate or start managed background work. The full child conversation is not persisted separately.

Resource discovery preserves the parent's project-trust decision. Declining trust skips project `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` while still loading repository context files such as `AGENTS.md`. Execution uses an isolated snapshot of global settings and trusted project overrides, including request and shell settings; cache warming is disabled for Agents.

## Model and thinking settings

Run `/agent` to choose **Model** or **Thinking**. The model picker is searchable; either setting can follow the current session. Choices apply only to future Agents and never switch the parent session or change running work.

Settings are stored in the global `settings.json`:

```json
{
  "extensionSettings": {
    "agent": {
      "model": "provider/model-id",
      "thinking": "high"
    }
  }
}
```

Omit either field to inherit it. Thinking is clamped to the effective model's supported levels. A configured model that no longer exists or has no authentication fails explicitly instead of silently selecting another model.

Malformed model or thinking fields are marked `[invalid]` in `/agent`, where you can replace them or explicitly reset each field to follow the current session. Escape leaves settings unchanged, and repairs preserve the other fields and extension namespaces. Invalid JSON or a malformed namespace object must be repaired in `settings.json`; Pi does not overwrite that damaged configuration automatically.

## Transcript and Tasks

The Transcript only describes status and current work. It never includes the Prompt or final report, and settled rows do not grow when expanded. On narrow terminals, status and `/tasks` guidance take priority over long task labels.

| State | Collapsed | Expanded |
|---|---|---|
| Running | One line with the latest tool, a short path or command target, and elapsed time | The same heading plus the latest five activities in `✓/…/✗ tool target · duration` form |
| Background handoff | One `Background · /tasks` status line | Identical |
| Completed | One duration and `/tasks` status line | Identical |
| Failed or cancelled | One short diagnostic or cancellation line | Identical |

Shell activity shows only the first non-empty command line and retains the actual tool name. Tasks Output holds bounded argument summaries and tool-failure excerpts while the Agent runs; successful intermediate tool output is not retained in the parent Tasks record. The final report replaces live activity.

In `/tasks`, each Agent remains an independent row:

- **Output** shows actual tool activity while running and the complete final report with Markdown formatting after successful completion.
- **Details** shows the full Prompt, working directory, model, and thinking level.

Use `tasks read`, `tasks wait`, or `tasks kill` with the Task ID. Selection, scrolling, cancellation, foreground detach, history, and completion delivery are owned by the shared Tasks implementation. Parent cancellation stops foreground-owned work, including cancellation received during startup; detached work continues until it finishes or is killed. Reload, session replacement, and shutdown cancel active Agents.

Reports are bounded to 24 KiB, activity history to the latest 50 tool calls, and published task results to the shared Tasks limits. Final reports, static Details, usage, and completion state restore through the parent session branch; live execution never resumes after restart.
