# Architecture

The repository contract is [AGENTS.md](../AGENTS.md). This document owns durable design decisions, subsystem boundaries, and architectural invariants.

## Placing new capabilities

Place new capabilities at the first level that can carry them:

1. **Extension (`src/extensions/<name>/`):** The default for any capability expressible via the public Extension API. Extensions never conflict with upstream and can be added, updated, or removed independently.
2. **Hook plus extension:** When the Extension API cannot reach required state or UI slots, add the smallest general-purpose hook to core (an event, a `ctx` method, or a registry), then implement the feature as an extension on top of it. Design hooks as general capabilities rather than feature-specific patches (`ctx.ui.editorHost`, `ctx.getContextSnapshot()`, dynamic keybindings).
3. **Core capability:** Only when a feature must integrate directly into the session lifecycle or interactive renderer (such as Tasks). Isolate custom logic in dedicated distribution modules and interact with upstream code via thin wrappers around unchanged bodies.

Every touched upstream path must be registered in `maintainers/concerns.json`; see [Keeping deviations small](upstream.md#keeping-deviations-small).

## Dependency boundary

Upstream libraries are consumed directly from published npm packages, pinned to exact versions. Never vendor or duplicate them.

| Direct consumers | Scope | Reason |
| --- | --- | --- |
| Pi AI, Agent core, TUI, Codemode, MCP, QuickJS WASI | Production | SDK, tools, interactive runtime, MCP transports, and sandboxed execution. |

## Subsystem ownership

- **Core:** Owns session lifecycle, keybinding registry, renderer integration, and native fallback tool presentation.
- **Bundled extensions:** Ordinary Extension API consumers that never import each other's internals. Upstream provides `llama`, `codemode`, `mcp`, and `tool-search`; the remaining bundled extensions are distribution additions.
- **Extension boundaries:** Bundled extensions remain decoupled. MCP discovers tool orchestrators (e.g. codemode) via upstream's `ToolDefinition.reachesTools` declaration rather than imports.

## Tasks subsystem

Tasks is a core capability rather than an extension because completion delivery and state journaling must tie directly to the session lifecycle.

### Responsibilities

- **Execution & handles (`core/tasks/runtime.ts`):** Admission, cancellation, execution handles, and foreground handoff.
- **Retention & quotas (`core/tasks/store.ts`):** Retained output files, cleanup, and separate foreground/background history quotas.
- **Journaling & delivery (`core/tasks/session.ts`, `delivery.ts`):** Session journal persistence, exactly-once usage accounting, completion delivery, and late-settlement quarantine.
- **Managed shell execution (`core/tools/shell-tool.ts`, `shell-execution.ts`):** Wraps upstream shell tools (`bash.ts`, `powershell.ts`) to provide background orchestration without duplicating process-tree handling.

### Invariants

- **Delivery pause:** Completion delivery pauses during preflight, compaction, session reload, tree navigation, and replacement, staying paused across deferred `agent_settled` handlers.
- **Queue consumption:** Queued next-turn context is consumed only after its entry is successfully persisted.
- **Post-compaction reminders:** Reminders for active tasks are projected into the next request from the live runtime; they are never persisted or allowed to trigger turns independently.
- **Steering isolation:** User steering interrupts only `tasks wait`, never task execution.
- **Quota isolation:** Background task volume does not block foreground command execution.

## Upstream-sensitive areas

Re-verify these areas whenever upstream synchronizations touch them:

- **Bundling:** `scripts/build-bundle.mjs` adapts upstream's bundling strategy for the standalone distribution (`dist/bundle/`). Entrypoints and lazy-loaded assets must be validated with packed tarball verification (`npm run verify:package-install`).
- **Compaction:** Auto-compaction converts `triggerPercent` to upstream's `reserveTokens`. The bundled `cached-compaction` extension hooks summary generation while leaving fallback and recovery native.
- **Context snapshots:** `ContextSnapshotCapture` mirrors canonical request projections (`sessionManager.buildSessionProjection()`) so consumers (such as BTW and cached compaction) receive the exact bytes sent to providers.
- **Tool presentation:** Upstream's `tool-execution.ts` owns execution lifecycle; the bundled `tool-presentation` extension injects compact TUI chrome via existing renderer hooks. Native Box rendering remains the zero-config fallback.
- **Windows compatibility:** Keep platform path and shell normalizations (`core/tools/shell-operations.ts`) minimal and focused on upstream compatibility gaps.
