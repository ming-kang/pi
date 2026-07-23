# Native tool presentation

This Fork changes Pi's native tool transcript presentation rather than replacing it with a separate `tools-view` extension.

## Visual language

```text
● ToolName(args)
│ result
```

States use the same shell:

```text
● ToolName(args)       completed call
● ToolName Working...  pending call
● ToolName(args)       failed call (error color)
│ result               successful or failed output
```

## Implementation boundary

The main entry point is:

```text
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
```

It owns:

- the default call/result shell;
- pending, success, and error states;
- call titles and generic argument summaries;
- collapsed and expanded result behavior;
- generic fallback rendering;
- image placement and conversion.

Built-in renderers remain responsible for semantic content such as file paths, syntax highlighting, search results, Diff previews, and command output. The outer shell is native so built-in tools, bundled extensions, and compatible third-party tools share the same presentation.

Consecutive tools may opt into a shared collapsed group through `toolGroup`. Built-in `read` and `find` calls use the `explore` group: their call rows render as one compact run with a single leading gap, while `Ctrl+O` restores each tool's complete call and result.

## Renderer inheritance

| Tool definition | Behavior |
|---|---|
| No `renderCall`/`renderResult` | Uses the Fork's native call and result fallback. |
| Custom renderer with the default shell | Uses the native shell around the custom content. |
| `renderShell: "self"` | Keeps complete ownership of the tool's layout. |

Built-in tool definitions are also used when an extension overrides only one renderer slot. A custom call renderer can inherit the built-in result renderer, and vice versa.

Renderer failures fall back to native generic output rather than breaking the transcript.

## Generic fallback

When no semantic renderer is available:

- arguments are serialized into a bounded one-line summary;
- output is collapsed to the most recent ten visual lines;
- `Ctrl+O` expands the complete output;
- historical tools that are no longer registered still receive the same shell;
- failed calls use the error-colored bullet while result details keep the result bar.

The fallback does not change tool schemas, execution logic, or result protocols.

## Built-in behavior preserved

The native path continues to preserve:

- `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit` semantics;
- faithful width-aware raw command previews for Bash;
- running Bash duration after the two-second progress threshold, without a permanent completion timer;
- Diff previews and first-change-line metadata for `edit`;
- syntax highlighting;
- image output and Kitty conversion;
- native collapsed/expanded handling;
- custom UI explicitly using `renderShell: "self"`.

`edit` now uses the native outer shell while keeping its asynchronous Diff preview and final Diff result.

## Deliberately rejected approaches

This Fork does not use:

- prototype patching of `ToolExecutionComponent` from an extension;
- same-name re-registration to replace built-in tools;
- a global renderer registry exposed through Extension API;
- a restored `tools-view` extension;
- forced decoration of third-party tools that explicitly own their shell.

Those approaches either depend on private runtime internals, change execution ownership, or cannot reliably cover independently loaded extensions.
