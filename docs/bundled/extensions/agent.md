# Agent — lightweight delegation

The bundled `Agent` extension adds the `Agent` tool and `/agent` settings command. One call delegates one self-contained task to a temporary Agent and returns its final report. Use it sparingly for independent work that clearly benefits from separate context or parallel execution. There are no General/Explore profiles, batch arrays, persistent worker identities, or chain modes.

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

Agents use the parent's working directory and share its canonical model/authentication runtime. Their isolated in-memory sessions have `read`, `bash`, `edit`, and `write`, with shell commands covering file discovery and search. They load applicable repository instructions and do not load extensions, skills, prompt templates, or themes. They cannot recursively delegate or start managed background work. The full child conversation is not persisted separately.

Resource discovery preserves the parent's project-trust decision. Declining trust skips project `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` while still loading repository context files such as `AGENTS.md`. Execution uses an isolated snapshot of global settings and trusted project overrides, including request and shell settings; cache warming is disabled for Agents.

## Model and thinking settings

Run `/agent` to choose **Model** or **Effort**, reusing the searchable `/model` and `/thinking` selectors. The compact panel shows the full `provider/model-id` and current effort on aligned single lines. An unset field adds `· Follow current session`; when the requested effort is unsupported, the panel shows the requested and effective levels, such as `max → high · Follow current session`. Fixed overrides also show a conversion when necessary, without the inheritance suffix. Choices apply only to future Agents and never switch the parent session or change running work.

**Reset to follow current session** is always available and clears both Agent overrides in one save, preserving unrelated settings. Resetting fields that already inherit is a no-op. Choosing a specific model or effort makes that field fixed, even when it equals the inherited value. Picker confirmation never changes global model or thinking defaults.

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

Malformed model or thinking fields are marked `[invalid]` in `/agent`, where you can replace them through their native picker or explicitly reset both fields to follow the current session. A missing model is marked `[unavailable]`, and effort stays `[unresolved]` rather than using the parent model's capabilities. Cancelling a picker leaves its setting unchanged; closing the panel retains earlier confirmed saves. Repairs preserve the other fields and extension namespaces. Invalid JSON or a malformed namespace object must be repaired in `settings.json`; Pi does not overwrite that damaged configuration automatically.

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

- **Output** shows actual tool activity while running and the final report with Markdown formatting after successful completion. Oversized reports remain available through their managed output file.
- **Details** shows the full Prompt, working directory, model, and thinking level.

Use `tasks read`, `tasks wait`, or `tasks kill` with the Task ID. Selection, scrolling, cancellation, foreground detach, history, and completion delivery are owned by the shared Tasks implementation. Parent cancellation stops foreground-owned work, including cancellation received during startup; detached work continues until it finishes or is killed. Reload, session replacement, and shutdown cancel active Agents.

Inline reports are bounded to 24 KiB. Longer reports are written in full to a managed temporary Markdown file, and the tool result includes a bash-style `Full output: <path>` notice. Use `read` on that path or `tasks read` for retained output; a failure to save the file falls back to a bounded report without changing the Agent's outcome. Activity history is limited to the latest 50 tool calls, and published task results use the shared Tasks limits. Inline report previews, static Details, usage, and completion state restore through the parent session branch. Managed output files follow the Tasks lifecycle and never survive restart; live execution never resumes either.
