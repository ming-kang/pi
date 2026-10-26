# Architecture

The repository contract is [AGENTS.md](../AGENTS.md). This page owns durable design decisions and the reasons behind local behavior; commands belong in the runbooks.

## Placing new capabilities

This distribution exists to change what Pi can do, and that work lasts longest when upstream files hold as little of it as possible. Place a new capability at the first level that can carry it:

1. **Extension.** If the public Extension API can express it, build it under `src/extensions/<name>/` and register it in `src/extensions/index.ts`. It never conflicts with upstream and can be replaced or dropped on its own.
2. **Hook plus extension.** If an extension cannot reach what it needs, add the smallest general-purpose hook to core (an event, a `ctx` method, a UI slot, or a registry), then build the feature as an extension on top of it. Design the hook as if upstream might adopt it: name it for what it exposes rather than for the feature that needs it, and make it usable by a third-party extension. Keep its implementation in a distribution-owned module so upstream files carry only the declaration and the call. `ctx.ui.editorHost`, `ctx.getContextSnapshot()`, extension settings, and the keybinding registry follow this pattern.
3. **Core capability.** Only when the feature must live inside the session lifecycle or the renderer, as Tasks does. Keep its logic in its own core modules and reach upstream code through thin wrappers around unchanged upstream bodies, as `AgentSession.prompt()` wraps `_promptBody()`.

A feature that keeps growing inside upstream files usually lacks a hook. Every touched upstream path still needs a claim in `concerns.json`; see [Keeping deviations small](upstream.md#keeping-deviations-small).

## Dependency boundary

Upstream libraries are consumed from their published npm packages, exactly pinned. A library belongs in `dependencies` when shipped JavaScript or public declarations need it, and in `devDependencies` when only excluded source or tests do.

| Direct consumers | Scope | Reason |
| --- | --- | --- |
| Pi AI, Agent core, TUI, Codemode, MCP, QuickJS WASI | Production | SDK, tools, interactive runtime, MCP transports, and sandbox execution. |

## Ownership

Core owns the global lifecycle, native tool presentation, renderer integration, and the keybinding registry. Bundled extensions are ordinary Extension API consumers: they register their own keybindings through `src/core/keybinding-registry.ts`, reach the main editor only through `ctx.ui.editorHost`, and never import each other. `llama`, `codemode`, `mcp`, and `tool-search` come from upstream; the other bundled extensions are distribution additions. MCP finds tool orchestrators such as codemode through the `pi:discover-tool-orchestrators` event rather than imports, so a third-party replacement keeps working.

## Tasks

Tasks is a core capability, not an extension, because completion delivery must follow the session lifecycle. Extensions use it through `ctx.tasks`.

| Module | Owns |
| --- | --- |
| `core/tasks/runtime.ts` | Execution handles, admission, cancellation, and foreground handoff. Executors get a task-local control, not the registry. |
| `core/tasks/store.ts` | Retained records, output cleanup, and history quotas. |
| `core/tasks/session.ts`, `delivery.ts` | Journal persistence, exactly-once usage, runtime replacement, late-settlement quarantine, completion claims, and persistence receipts. |
| `core/tools/bash.ts`, `powershell.ts` | Upstream spawn, timeout, and process-tree handling shared by both shell tools. |
| `core/tools/shell-tool.ts`, `shell-execution.ts` | The managed definition (background, handoff) and the single output owner for a running command. |
| `core/tools/tasks.ts`, `modes/interactive/tasks/` | The `tasks` tool, `/tasks`, the detach key, the statusline item, and completion cards. |

The shell process loop stays in upstream `core/tools/bash.ts`; `shell-tool.ts` adds only the model-facing contract that must differ, so process fixes merge normally. `shell-operations.ts` owns the narrow Windows command normalization.

Invariants:

- Completion delivery pauses during preflight, compaction, reload, tree navigation, and session replacement, and stays paused across runs that `agent_settled` handlers defer; otherwise a completion turn and a deferred prompt can start in the same idle gap.
- Queued next-turn context is consumed only after its entry is persisted.
- Post-compaction active-task reminders are computed from the live runtime into the next request projection, never persisted or allowed to start a turn; only a successful assistant response consumes them.
- Steering interrupts only `tasks wait`, never task execution. A waitAny observes one initial cohort and acknowledges only its winner after the tool result persists; the other tasks return to ordinary delivery.
- Only background work counts toward the active limit, so a background task never blocks a foreground command; foreground and background history have separate quotas.
- `task-result` and `task-completion` records are version 2 and `task-usage` is version 1; older records are not migrated, and runtime replacement never reattaches execution.

## Upstream-sensitive areas

Re-check these when a synchronization touches them:

- **Bundling:** `scripts/build-bundle.mjs` follows upstream's build strategy, adapted to a standalone package. CLI and RPC run from `dist/bundle/`, the SDK keeps tsc output, and lazy-loaded workers and providers sit beside the chunks that load them. When entrypoints or lazy loaders change, verify a packed installation; bundle size proves nothing.
- **Compaction:** the lifecycle is upstream's. `SettingsManager.getCompactionSettings()` only converts `triggerPercent` into upstream's `reserveTokens` for the active model. The bundled `cached-compaction` extension replaces ordinary summary generation through the public hook; overflow recovery and failed attempts remain native. Previous compaction file details are consumed by shape for both native and extension-provided entries.
- **Context snapshots:** `ContextSnapshotCapture` records the request prefix after every request projection, so snapshot consumers such as BTW and cached compaction reuse the exact bytes the provider received. It reads `sessionManager.buildSessionProjection()`, which is canonical, rather than `agent.state.messages`, which is a cache. It wraps upstream's `convertToLlm` and request-option builder instead of copying them.
- **Tool presentation:** upstream's `components/tool-execution.ts` remains the lifecycle owner, with thin TUI-only shell, row-gap, result-context, and disposal hooks. The bundled `tool-presentation` extension attaches the distribution shell through the existing renderer resolver; `tool-view/` owns visual policy and compatibility adapters, not a second lifecycle implementation. Upstream's Box is the fallback when `builtin:tool-presentation` is disabled. Verify pending, success, error, collapsed, expanded, `/reload`, `/tree`, HTML export, and native fallback states in a real terminal.
- **Windows and lifecycles:** keep the normalization in `core/tools/shell-operations.ts` narrow, and re-check process behavior, selector disposal, and timer lifecycles after upstream changes.
