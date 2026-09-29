# Explore

The `explore` tool runs a temporary read-only agent to investigate a self-contained question. Use it when the relevant location is unknown or an answer requires tracing several files. For a known path or exact symbol, use `read`, `grep`, `find`, or `ls` directly.

```json
{
  "query": "How does model selection reach a new session? Include source paths and line numbers.",
  "path": "src",
  "background": false
}
```

`query` is required and accepts up to 16 KiB. `path` is an optional file or directory relative to the current working directory, defaulting to that directory. It defines the allowed reading scope. Paths outside it, including links resolving outside it, are rejected. Directory searches do not follow symbolic links; Explore ignores user ripgrep configuration so it cannot enable link traversal. These tool checks are not an operating-system sandbox and do not provide a snapshot of files being edited concurrently.

Each invocation has one independent in-memory session with `read`, `grep`, `find`, and `ls`. It receives the question rather than the parent conversation and does not load extensions, skills, prompt templates, or project context files. It can search and read until it has an answer; there is no fixed response-count limit. Context compaction and request retries use the existing session mechanisms.

## Reports and Tasks

The report contains an answer, source evidence with paths and line numbers, and additional information when uncertainties or blockers remain. Reports are bounded to 24 KiB and 2,000 lines, with an explicit truncation notice. Cancellation or failure preserves available partial findings and the reason.

Foreground calls wait for the report. In interactive mode, Ctrl+B hands the same investigation to the background. With `background: true`, the tool returns a Task ID after initialization and the report is delivered automatically. SDK hosts must enable background execution with `tasksEnabled`; other hosts can use foreground calls.

In `/tasks`, Explore supplies the Information region with the full question, scope, model, and thinking level. The Output region shows recent actual tool activity and the streamed report. The panel handles selection and independent scrolling. When the selected investigation finishes, its report remains on the right until another task is selected or the panel closes. Completed tasks do not appear when reopening the panel.

Use `tasks read`, `tasks wait`, or `tasks kill` with the Task ID. Reloading or closing the session cancels active investigations. The main session saves the final result, display data, and usage through Tasks; intermediate file contents and the investigation conversation are not saved separately. Saved results can be read after restart, but execution cannot resume.

## Model selection

`/explore` opens a searchable model picker in the interactive terminal. Choose **Follow current session** or a specific model. Enter saves, Escape cancels. The selection affects future investigations only; it does not switch the main model or change running tasks. Thinking follows the main session's level at startup, adjusted to the investigation model's capabilities.

The global `settings.json` stores the choice:

```json
{
  "extensionSettings": {
    "explore": {
      "model": "provider/model-id"
    }
  }
}
```

Omit `model` to follow the current session. A configured model that is missing or lacks authentication produces an error instead of silently choosing another model.

## Extension settings API

Extensions can store a JSON object in their own global namespace:

```typescript
const settings = ctx.getExtensionSettings("my-extension");
await ctx.setExtensionSettings("my-extension", { ...settings, enabled: true });
```

Reads return a detached object. Writes replace only that namespace, merge with the current file under the SettingsManager lock, and reject if parsing or saving fails. Await the write before reporting success. Unchanged values do not rewrite the file. Namespace names contain lowercase letters, digits, and hyphens, start with a letter, and have at most 64 characters. Project settings do not override this global API.
