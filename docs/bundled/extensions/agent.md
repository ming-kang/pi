# Agent — lightweight delegation

The bundled `Agent` extension adds the `Agent` tool and `/agent` settings command. One call delegates one self-contained task to a temporary Agent and returns its final report; the Agent does not converse with its parent while it runs. Use it when independent work clearly benefits from separate context or parallel execution. Keep design and substantial coding in the main session; Agents are primarily for independent research, verification, and well-specified, self-contained implementation. Handle known-path reads and small edits directly. There are no General/Explore profiles, batch arrays, persistent worker identities, chain modes, or mid-run messaging and steering.

## Tool contract

```json
{
  "description": "Inspect Tasks persistence",
  "prompt": "Trace task-record restoration and report the relevant paths and invariants. Do not edit files.",
  "background": false
}
```

- `prompt` is required, must be self-contained, and is limited to 16 KiB. The Agent cannot see the parent conversation. Include the goal and rationale, prior findings, relevant paths and constraints, whether to investigate or edit, and expected verification. For open investigations, hand over the question rather than a fragile step-by-step procedure.
- `description` is an optional short (3–5 word) label for the Transcript and `/tasks`; otherwise Pi derives one from the prompt.
- `background` is optional. Foreground waits for the report; `true` returns a Task ID once the Agent has initialized, or at once while it waits for a slot, and delivers the report automatically. Interactive **Ctrl+B** can detach a foreground call without restarting it.

Background Agents, whether requested with `background: true` or detached with **Ctrl+B**, are admitted only while the `tasks` tool is active, because the parent could otherwise start work it cannot read, wait for or stop. When `tasks` is disabled or deactivated, `background: true` is rejected without starting anything and **Ctrl+B** leaves the call in the foreground; foreground calls are otherwise unaffected. A call becomes background only once the Agent has initialized and accepted the work, so a detach requested during initialization waits for that, and if initialization fails first the call answers in the foreground.

Issue parallel `Agent` calls for independent work. Each call is a separate Transcript row and Task, including its own completion notification; there is no aggregate batch view. At most four Agents run at once in a session; additional calls wait as queued Tasks and start when a slot frees. A queued background call returns its Task ID immediately, and **Ctrl+B** can move a queued foreground call to the background before it starts. Parallel tasks must not perform overlapping writes.

Agents use the parent's working directory and share its canonical model/authentication runtime. Their isolated sessions have `read`, `bash`, `edit`, and `write`, with shell commands covering file discovery and search. They load applicable repository instructions and do not load extensions, skills, prompt templates, or themes. They cannot recursively delegate or start managed background work. In a saved session, each Agent also keeps its complete report and its child transcript beside the session (see [Saved reports and transcripts](#saved-reports-and-transcripts)); an unsaved session keeps neither.

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
| Running | One line with the latest tool, a short path or command target, and elapsed time | The same heading plus the latest five tool calls as aligned `glyph tool target · duration` rows |
| Background handoff | One `Background · /tasks` status line | Identical |
| Completed | One duration and `/tasks` status line | Identical |
| Failed or cancelled | One short diagnostic or cancellation line | Identical |

Shell activity shows only the first non-empty command line and retains the actual tool name. Path targets that lie inside the Agent's working directory are shown relative to it, with forward slashes; paths outside it stay absolute. The human-only Tasks display holds bounded argument summaries and one-line tool-failure excerpts; successful intermediate tool output is not retained in the parent Tasks record. While running, model-facing `tasks read` returns one status line, such as `Agent running · 3 tool calls · latest: bash npm test`; after settlement it returns the final report. Intermediate assistant text and Tool calls never reach the parent model. To change direction, kill the Agent and delegate again with a better briefing.

In `/tasks`, each Agent remains an independent row:

- **Output** shows only what a person needs from the Agent's current state. While it runs, that is its compact tool calls, one per line, with no heading:

  ```text
  … 12 earlier tool calls
  ✓ read src/core/tasks/store.ts · 4ms
  ✓ bash npm test · 6.2s
  ✗ bash npm run check · 41.0s
         src/index.ts:12:5 - error TS2322
  … read README.md
  ```

  Each call is `glyph tool target · duration`, with the tool-name column padded to the longest shown name (at most 8 characters) so targets line up. The glyph is `✓` for success, `…` for running, `✗` for failure and `⊘` for cancellation. When more than the latest 50 calls happened, the first line counts the earlier ones. A failed call adds one line under its target holding the first non-empty line of its error, clipped to about 160 characters. Durations read `42ms` under a second, `6.2s` under a minute, then `1m 5s`. While the Agent runs, the list is styled with the theme: the glyph by status (running warning, success green, failure red, cancellation muted), the tool name as a tool title, the target muted and the duration dim, with the error line in the error color. Targets are clipped to the panel width, never the duration, and the running call shows how long it has been running, such as `… bash npm test · 12s`. The Transcript's expanded row renders the same rows through the same code, so the two always agree. The model never sees this list; `tasks read` still returns the one-line status. Once the Agent finishes, whatever its outcome, Output shows only its final report (Markdown for a completed report) or, for a failed or cancelled Agent, its report so far and diagnostic. Oversized reports remain available through their managed output file.
- **Details** shows the full Prompt, working directory, model, and thinking level. Once the Agent settles, it also shows `Tool calls` (every call, for example `23 · 2 failed`), `Edited` (see below) and, in a saved session, the `Report` and `Transcript` paths.

Use `tasks read`, `tasks wait`, or `tasks kill` with the Task ID. Reading requires no view options: the status line or report is the model projection, while the `/tasks` panel adds the human-only tool-call list while the Agent runs. Selection, scrolling, cancellation, foreground detach, history, and completion delivery are owned by the shared Tasks implementation. Parent cancellation stops foreground-owned work, including cancellation received during startup; detached work continues until it finishes or is killed. Reload, session replacement, and shutdown cancel active Agents.

Inline reports are bounded to 24 KiB. In a saved session, a longer report is read from its saved `report.md` (below), and the tool result includes a bash-style `Full output: <path>` notice naming it. In an unsaved session, the full text goes to a managed temporary Markdown file instead, named the same way. Use `read` on that path or `tasks read` for retained output; a failure to save the file falls back to a bounded report without changing the Agent's outcome. Activity history is limited to the latest 50 tool calls, and published task results use the shared Tasks limits. A background completion delivers the report from its beginning, whole when it fits the notification budget, so the parent reads the same report a foreground call would have returned. Inline report previews, Details, usage, and completion state restore through the parent session branch. Temporary output files follow the Tasks lifecycle and never survive restart; saved reports and transcripts do survive, but live execution never resumes.

### Saved reports and transcripts

When the main session is saved, an Agent keeps these files in `<session-name>/agents/<task-id>/`, where `<session-name>/` is the artifacts directory beside the session's `.jsonl` file:

- `report.md` holds the complete final report, whatever its size. Tasks retention and shutdown never delete it, so the `Full output:` path in a saved transcript stays valid after `pi -c`.
- `transcript.jsonl` is the Agent's conversation as an ordinary Pi session file whose header `parentSession` is the main session file. It is a record only: it is never listed in `/resume` or continued by `pi -c`, and an Agent never resumes. It exists once the Agent has started its conversation.

Deleting the session from `/resume` deletes these files with it. Forks and clones do not copy them. Sessions that are not saved (`--no-session`) keep neither file.

A settled Agent's Details also carry:

| Row | Meaning |
| --- | --- |
| `Tool calls` | Every call the Agent made, with failures: `23` or `23 · 2 failed`. Not limited to the latest 50 listed. |
| `Edited` | Files the Agent changed with `edit` or `write` calls that succeeded (not through `bash`), once each in first-edit order, relative to the working directory when inside it: `src/a.ts, README.md +3 more`. Omitted when none. |
| `Report`, `Transcript` | Paths of the saved files. |

When the Agent edited files, the report returned to the model ends with one more line, `Edited (edit/write): a.ts, b.ts +N more`, after any truncation notice and bounded to 1 KiB. A failed or cancelled Agent reports the same rows and line.
