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
| Chord | Production | The bundles keep Agent core's external Chord imports. It does not enable the experimental server. |
| Client, Durable, Protocol, Server | Development | Imported only under `src/client/`, `src/experimental/`, and `src/cli/experimental/`, which the build excludes. |

The experimental `client` and `experimental/plugin` subpaths expose only the `source` condition, and the durable server is POSIX-only.

## Ownership

Core owns the global lifecycle, native tool presentation, renderer integration, and the keybinding registry. Bundled extensions are ordinary Extension API consumers: they register their own keybindings through `src/core/keybinding-registry.ts`, reach the main editor only through `ctx.ui.editorHost`, and never import each other. `llama`, `codemode`, `mcp`, and `tool-search` come from upstream; the other bundled extensions are distribution additions. MCP finds tool orchestrators such as codemode through the `pi:discover-tool-orchestrators` event rather than imports, so a third-party replacement keeps working.

## Tasks

Tasks is a core capability, not an extension, because completion delivery must follow the session lifecycle. Extensions use it through `ctx.tasks`.

| Module | Owns |
| --- | --- |
| `core/tasks/runtime.ts` | Execution handles, admission, cancellation, and foreground handoff. Executors get a task-local control, not the registry. |
| `core/tasks/store.ts` | Retained records, output cleanup, and history quotas. |
| `core/tasks/session.ts`, `delivery.ts` | Journal persistence, exactly-once usage, runtime replacement, late-settlement quarantine, completion claims, and persistence receipts. |
| `core/tools/shell-tool.ts`, `shell-execution.ts` | Shared Bash and PowerShell execution and output policy. |
| `core/tools/tasks.ts`, `modes/interactive/tasks/` | The `tasks` tool, `/tasks`, the detach key, the statusline item, and completion cards. |

Invariants:

- Completion delivery pauses during preflight, compaction, reload, tree navigation, and session replacement, and stays paused across runs that `agent_settled` handlers defer; otherwise a completion turn and a deferred prompt can start in the same idle gap.
- Queued next-turn context is consumed only after its entry is persisted.
- Only background work counts toward the active limit, so a background task never blocks a foreground command; foreground and background history have separate quotas.
- `task-result` and `task-completion` records are version 2 and `task-usage` is version 1; older records are not migrated, and runtime replacement never reattaches execution.

## Upstream-sensitive areas

Re-check these when a synchronization touches them:

- **Bundling:** `scripts/build-bundle.mjs` follows upstream's build strategy, adapted to a standalone package. CLI and RPC run from `dist/bundle/`, the SDK keeps tsc output, and lazy-loaded workers and providers sit beside the chunks that load them. When entrypoints or lazy loaders change, verify a packed installation; bundle size proves nothing.
- **Compaction:** the lifecycle is upstream's. `SettingsManager.getCompactionSettings()` only converts `triggerPercent` into upstream's `reserveTokens` for the active model.
- **Context snapshots:** `ContextSnapshotCapture` records the request prefix after every request projection, so snapshot consumers such as BTW reuse the exact bytes the provider received. It reads `sessionManager.buildSessionProjection()`, which is canonical, rather than `agent.state.messages`, which is a cache. It wraps upstream's `convertToLlm` and request-option builder instead of copying them.
- **Tool presentation:** `src/modes/interactive/tool-view/` replaces upstream's tool block, and upstream's `components/tool-execution.ts` is dropped. Port its fixes (image conversion, click to expand, lifecycle) and renderer changes by hand, and verify pending, success, error, collapsed, expanded, `/reload`, and `/tree` states in a real terminal.
- **Windows and lifecycles:** keep shell normalization narrow, and re-check process behavior, selector disposal, and timer lifecycles after upstream changes.
