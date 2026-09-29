# Native tool presentation

The `@astralyn/pi` package draws every tool call in the interactive transcript as one compact block: a status dot and a rail. Tools in the transcript are not cards, have no background color, and show no timers of their own.

## Visual language

```text
I'll look at the code.

● read src/app.ts:1-80
● grep /useState/ in src
● edit src/app.ts
│  1 const a = 0
│ -2 const b = 1
│ +2 const b = 2
● $ npm test
│ ... (14 earlier lines, ctrl+o to expand)
│ FAIL a.test.ts
│
│ Command exited with code 1
│
│ Took 4.2s

The tests failed.
```

- The dot is the tool's state: the warning color while the call is pending or running, green after success, and red after failure.
- The rail continues through every visual line that belongs to the same tool. A blank output line renders as a bare `│`.
- Tool blocks sit directly under each other with no blank line. Text before or after a run of tools keeps one blank line.
- `read`, `grep`, `find`, and `ls` show only their header until expanded. A failed call always shows its error.
- Consecutive calls never merge into a group. Every call keeps its own row, and the configured expand-tools key (`Ctrl+O` by default) or a click on the row shows its complete result.

The bash renderer shows its own `Elapsed` line while a command runs and a fixed `Took` line after it settles. The shell adds no progress row, and other renderers that refresh over time schedule their own repaints: they arm a timer in renderer state, call the render context's `invalidate()`, and clear the timer on the first settled render. The shell calls `state.dispose()` when a row is disposed, so a timer never outlives its row.

The `Ctrl+B` background hint is not part of a tool row. Once a foreground Bash or Subagent execution has run for ten seconds and can still move, the Background extension shows `Ctrl+B to background` in the statusline, next to the `bg N active` count.

## Implementation boundary

The look is defined in one place, `src/modes/interactive/tool-view/style.ts`: the marker and rail glyphs, their colors, the spacing between blocks, and which tools fold their result. `FramedComponent` in the same file hangs a component's lines off the marker or the rail and derives the gutter width from the glyphs.

`tool-view/tool-execution.ts` owns one call's lifecycle: pending, success and error states, expansion, image placement and Kitty conversion, and renderer disposal. `tool-view/chat.ts` owns the chat container that removes the blank line between consecutive tool rows and disposes rows when the chat clears. Extension tools and built-in tools use the same shell, so a third-party tool gets the same dot and rail without any change.

Built-in renderers remain responsible for semantic content such as file paths, syntax highlighting, search results, Diff previews, and command output. They return plain components; the shell frames them.

## Renderer inheritance

| Tool definition | Behavior |
|---|---|
| No `renderCall`/`renderResult` | Uses the native call and result fallback. |
| Custom renderer with the default shell | Uses the native shell around the custom content. |
| `renderShell: "self"` | Keeps complete ownership of the tool's layout. |

Built-in tool definitions are also used when an extension overrides only one renderer slot. A custom call renderer can inherit the built-in result renderer, and vice versa. An extension that overrides a built-in tool with its own result renderer controls what that row shows, including when it is collapsed.

Renderer failures fall back to native generic output rather than breaking the transcript.

## Generic fallback

When no semantic renderer is available:

- arguments are serialized into a bounded one-line summary;
- output is collapsed to the most recent ten visual lines;
- a hint above the tail reports the number of hidden earlier lines and the configured expand key;
- expanding restores the complete output;
- historical tools that are no longer registered still receive the same shell;
- failed calls use the error-colored dot while result details keep the rail.

The fallback does not change tool schemas, execution logic, or result protocols.

## Built-in behavior preserved

The presentation continues to preserve:

- `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit` semantics;
- faithful width-aware raw command previews for Bash, with honest multi-line and width truncation markers;
- a ten-line collapsed Diff preview for `edit`, with the complete Diff restored on expand;
- syntax highlighting;
- image output and Kitty conversion;
- click to expand and collapse;
- custom UI explicitly using `renderShell: "self"`;
- independently refreshed custom elapsed time and retry countdowns.

## Deliberately rejected approaches

The package does not use:

- prototype patching of `ToolExecutionComponent` from an extension;
- same-name re-registration to replace built-in tools;
- a global renderer registry exposed through Extension API;
- a restored `tools-view` extension;
- forced decoration of third-party tools that explicitly own their shell;
- merging consecutive calls into a collapsed group, or a shell-level progress row.

Those approaches either depend on private runtime internals, change execution ownership, cannot reliably cover independently loaded extensions, or add presentation that the compact block does not need.
