# Architecture

The repository contract is [AGENTS.md](../AGENTS.md). This document owns durable design decisions, subsystem boundaries, and architectural invariants.

## Placing new capabilities

Place new capabilities at the first level that can carry them:

1. **Extension (`src/extensions/<name>/`):** The default for any capability expressible via the public Extension API. Extensions never conflict with upstream and can be added, updated, or removed independently.
2. **Hook plus extension:** When the Extension API cannot reach required state or UI slots, add the smallest general-purpose hook to core (an event, a `ctx` method, or a registry), then implement the feature as an extension on top of it. Design hooks as general capabilities rather than feature-specific patches (`ctx.ui.editorHost`, `ctx.getContextSnapshot()`, dynamic keybindings).
3. **Core capability:** Only when a feature must integrate directly into the session lifecycle or native execution (such as managed Tasks). Isolate custom logic in dedicated distribution modules and interact with upstream code via thin wrappers around unchanged bodies.

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

Tasks splits durable execution from its replaceable management surface. The core owns facts that require session-transaction boundaries; the bundled `tasks` extension owns every user-facing management feature. `interactive-mode.ts`, the native tool registry, and native slash commands do not know about `/tasks`.

### Responsibilities

- **Admission (`core/tasks/runtime.ts`):** Validation, background capacity, waits, reads, and the registry of live executions.
- **One execution (`core/tasks/execution.ts`):** The life of a single run: start, accept, publish, handoff, cancellation, steering, and settlement. A caller can be handed off while the task is queued or after `accept()`; never between `run` starting and acceptance.
- **Concurrency lanes (`core/tasks/scheduler.ts`):** Executor-declared `{ key, limit }` lanes. Queued work is a visible task whose `run` starts when a slot frees, so executors need no private gates.
- **Retention & quotas (`core/tasks/store.ts`):** Retained output files, cleanup, and separate foreground/background history quotas.
- **Wait policy (`core/tasks/limits.ts`, `format.ts`):** One definition of the 20-second default, 1-second tool floor, and 10-minute ceiling shared by runtime and management; observation timeouts never cancel execution. Compact duration labels omit zero components.
- **Journaling & delivery (`core/tasks/session.ts`, `delivery.ts`):** Session journal persistence, exactly-once usage accounting, completion delivery, and late-settlement quarantine. Each settlement appends one `task-record` holding the terminal snapshot and its usage.
- **Persisted shape (`core/tasks/codec.ts`):** The one reader for version-3 snapshots, shared by history restoration, completion details, and usage accounting.
- **Model projection (`core/tasks/presentation.ts`):** Background completion text. A `log` contributes its tail; a `report` arrives from its beginning, as the foreground result would have.
- **Session bridge (`TasksContext.session`):** The small public adapter for host-backed wait receipts, steering interruption, and branch-impact queries. Standalone runtimes omit it; consumers never import `TaskSession`.
- **Managed shell execution (`core/tools/shell-tool.ts`, `shell-execution.ts`):** Wraps upstream shell tools (`bash.ts`, `powershell.ts`) to provide background orchestration without duplicating process-tree handling.
- **Executor presentation (`core/tasks/types.ts`, `extensions/tasks/ui/`):** Executors declare data, not UI: a `label`, an `input` such as a command or prompt, labelled `facts`, and whether their `output` is a log or a report. The panel and completion card render that data identically for every executor and never branch on `kind`. Published results remain model-readable Output, with an optional human-only `display` suffix for Tool calls or parent-message history. Executors need no custom panel registry or persisted UI components.
- **Executor channel (`TaskControl.channel`):** `send` pushes an explicit `task-message`; `onSteer` handlers answer whether they actually took the guidance, so `tasks steer` never reports delivery to a worker that cannot consume it.
- **Isolated sessions (`core/isolated-session.ts`):** Builds an in-memory child `AgentSession` from a settings snapshot with no extensions and no background capability. The Agent extension uses it for workers.
- **Management (`extensions/tasks/`):** The `tasks` tool, `/tasks` command and panel, status/detach behavior, completion renderer, keybindings, keyboard-help section, and tree-navigation confirmation. The extension uses `ExtensionAPI`, `TasksContext`, and shared presentation primitives, never `TaskSession` or `interactive-mode` internals.
- **Generic UI registries (`core/keybinding-registry.ts`):** Extension-owned configurable bindings, editor-global reservations, and keyboard-help sections; no Tasks-specific entries live in the core binding or help tables.

### Invariants

- **Delivery pause:** Completion delivery pauses during preflight, compaction, session reload, tree navigation, and replacement, staying paused across deferred `agent_settled` handlers.
- **Queue consumption:** Queued next-turn context and explicit task messages are consumed only after their entries are successfully persisted; task messages share completion delivery pauses and retry handling.
- **Post-compaction reminders:** Reminders for active tasks are projected into the next request from the live runtime; they are never persisted or allowed to trigger turns independently.
- **Steering isolation:** User steering interrupts only `tasks wait`, never task execution.
- **Quota isolation:** Background task volume does not block foreground command execution.
- **Released records:** Older `task-result` history is ignored without migration, but released `task-usage` entries still count toward usage totals.

## Upstream-sensitive areas

Re-verify these areas whenever upstream synchronizations touch them:

- **Bundling:** `scripts/build-bundle.mjs` adapts upstream's bundling strategy for the standalone distribution (`dist/bundle/`). Entrypoints and lazy-loaded assets must be validated with packed tarball verification (`npm run verify:package-install`).
- **Compaction:** Auto-compaction converts `triggerPercent` to upstream's `reserveTokens`. The bundled `cached-compaction` extension hooks summary generation while leaving fallback and recovery native.
- **Context snapshots:** `ContextSnapshotCapture` mirrors canonical request projections (`sessionManager.buildSessionProjection()`) so consumers (such as BTW and cached compaction) receive the exact bytes sent to providers.
- **Tool presentation:** Upstream's `tool-execution.ts` owns execution lifecycle; the bundled `tool-presentation` extension injects compact TUI chrome via existing renderer hooks. Native Box rendering remains the zero-config fallback.
- **Windows compatibility:** Keep platform path and shell normalizations (`core/tools/shell-operations.ts`) minimal and focused on upstream compatibility gaps.
