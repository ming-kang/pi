# Native tool presentation

The `@astralyn/pi` package uses Pi's native tool transcript presentation rather than replacing it with a separate `tools-view` extension.

## Visual language

```text
● ToolName(args)
│ first result line
│ second result line
│
│ final result line
```

The dim result rail continues through every visual line; an empty output line renders as a bare `│`. Calls keep their status in the leading dot: warning while pending or running, green after success, and red after failure. For bash commands that are still running after two seconds, the shell adds a live result row such as `Running… (2.1s)` and removes it when the call settles. Other tools with live progress render it themselves; tools using `renderShell: "self"` continue to own their entire presentation.

Time-driven renderers schedule their own repaints: while a result is partial they arm a timer in renderer state and call the render context's `invalidate()`, clearing the timer on the first settled render. Renderers compute elapsed/countdown values from absolute timestamps or deadlines, so a delayed repaint never changes the underlying wall-clock meaning.

## Implementation boundary

The native tool presentation owns:

- the default call/result shell;
- pending, success, and error states;
- call titles and generic argument summaries;
- collapsed and expanded result behavior;
- generic fallback rendering;
- image placement and conversion.

Built-in renderers remain responsible for semantic content such as file paths, syntax highlighting, search results, Diff previews, and command output. The outer shell is native so built-in tools, bundled extensions, and compatible third-party tools share the same presentation.

Consecutive tools may opt into a shared collapsed group through `toolGroup`. Built-in `read`, `find`, `grep`, and `ls` calls use the `explore` group, and the bundled `todo` tool uses the `todo` group: their call rows render as one compact run with a single leading gap, while the configured expand-tools key (`Ctrl+O` by default) restores each tool's complete call and result. Collapsed Todo rows are result-aware: successful current snapshots summarize the completed operation, including task IDs and subjects for creation, rather than only its arguments. Failures include a sanitized reason capped at 120 characters; missing or unrecognized result details fall back safely to the call summary.

## Renderer inheritance

| Tool definition | Behavior |
|---|---|
| No `renderCall`/`renderResult` | Uses the package's native call and result fallback. |
| Custom renderer with the default shell | Uses the native shell around the custom content. |
| `renderShell: "self"` | Keeps complete ownership of the tool's layout. |

Built-in tool definitions are also used when an extension overrides only one renderer slot. A custom call renderer can inherit the built-in result renderer, and vice versa.

Renderer failures fall back to native generic output rather than breaking the transcript.

## Generic fallback

When no semantic renderer is available:

- arguments are serialized into a bounded one-line summary;
- output is collapsed to the most recent ten visual lines;
- a shared hint above the tail reports the number of hidden earlier lines and the configured expand key;
- expanding restores the complete output;
- historical tools that are no longer registered still receive the same shell;
- failed calls use the error-colored bullet while result details keep the result rail.

The fallback does not change tool schemas, execution logic, or result protocols.

## Built-in behavior preserved

The native path continues to preserve:

- `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit` semantics;
- faithful width-aware raw command previews for Bash, with honest multi-line and width truncation markers;
- shell-wide running duration after the two-second progress threshold, with lifecycle-safe refresh disposal and no permanent completion timer;
- path links and consistent search flags/limits across built-in renderers;
- Diff statistics plus a ten-line collapsed Diff preview for `edit`, with the complete Diff restored on expand;
- syntax highlighting;
- image output and Kitty conversion;
- native collapsed/expanded handling;
- custom UI explicitly using `renderShell: "self"`;
- independently refreshed custom elapsed time and retry countdowns without a duplicate generic progress row.

Built-in result truncation hints share the same `… (N earlier/more lines, … to expand)` language and correct singular/plural forms. `edit` uses the native outer shell while keeping its asynchronous Diff preview and final Diff result.

## Deliberately rejected approaches

The package does not use:

- prototype patching of `ToolExecutionComponent` from an extension;
- same-name re-registration to replace built-in tools;
- a global renderer registry exposed through Extension API;
- a restored `tools-view` extension;
- forced decoration of third-party tools that explicitly own their shell.

Those approaches either depend on private runtime internals, change execution ownership, or cannot reliably cover independently loaded extensions.
