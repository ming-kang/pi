# Delta rationale and admission

[`upstream.json`](upstream.json) is the sole machine-readable record of delta IDs, titles, disposition, risk, private upstream assumptions, path registry, and budget. Do not duplicate its current counts, path inventories, or machine fields here. The behavioral assumptions below explain why a unit exists; the manifest determines which assumptions are private and which files belong to the unit.

## Admission and re-evaluation

The upstream delta is frozen: do not add or expand a hybrid change merely because it is convenient. First use the public Extension API, then a distribution-owned adapter, before modifying an upstream-aligned path. This does not permit a boundary prohibited by [`AGENTS.md`](../AGENTS.md): no monorepo recreation, dependency vendoring or patching, Fork framework, cross-extension internal imports, or display-only protocol/schema/result changes.

A proposed new or expanded unit needs owner-approved review material that states the need, why an extension or adapter is insufficient, upstream behavioral assumptions, automated and manual verification, failure risk, and a concrete removal or re-evaluation condition. Update the manifest registry and budget only for the approved final delta; update this guide with the durable human rationale. Re-evaluate high-lifecycle-risk changes whenever their upstream lifecycle, rendering, terminal, or timing assumptions change.

## dist-standalone

**Rationale and scope.** The package ships independently as `@astralyn/pi`, so package identity, standalone resolution, package metadata, and release metadata differ from the upstream workspace layout.

**Upstream assumptions.** Identity constants and extension-package resolution remain localized enough to adapt without recreating workspace discovery.

**Verification.** Run package/configuration, command-path, extension-discovery, resource-loading, and version-check tests; manually install a packed artifact and verify its command and assets resolve as published.

**Exit/re-evaluation.** Remove adapters only if this distribution stops shipping a standalone package or adopts an upstream layout that is standalone-compatible; review every upstream packaging or resolution change.

## dist-attribution

**Rationale and scope.** Install reporting is removed; the retained compatibility setting controls only optional provider attribution.

**Upstream assumptions.** Upstream continues to funnel installation reporting and its first-run/update call sites through a separable telemetry path.

**Verification.** Run `test/sdk-openrouter-attribution.test.ts`; manually exercise settings selection and first-run/update flows, confirming no request reaches the former install-report endpoint while provider attribution remains configurable.

**Exit/re-evaluation.** Remove compatibility wording and code when an adopted upstream setting separates attribution from installation reporting; review telemetry and settings migrations.

## plat-windows-bash

**Rationale and scope.** A narrow Windows normalization prevents CMD-style `nul` redirects from creating an undeletable literal file, while tests account for Windows symlink capability.

**Upstream assumptions.** Local Bash operations normalize a command immediately before spawning the resolved POSIX shell.

**Verification.** Run the Bash redirect and resource-loader tests; on Windows, execute a `2>nul` command in a real session and confirm no `nul` file appears.

**Exit/re-evaluation.** Remove the normalization when an adopted upstream release supplies it, and retain any symlink-capability accommodation only while Windows requires it; review Windows-support changes.

## core-mid-turn-compaction

**Rationale and scope.** Context is checked after a completed tool batch and before continuing queued steering or follow-up work to the next provider request. Successful compaction continues the same run. Unsafe retained context, aborts, and failures fail closed at an explicit error or aborted lifecycle boundary; a voluntary `session_before_compact` cancellation instead continues the run and suppresses further mid-turn checks for that run. The timing value distinguishes `manual`, `midTurn`, `postRun`, and `prePrompt` contexts.

**Upstream assumptions.** The stateful Agent exposes `prepareNextTurnWithContext` for same-run continuation but no low-level graceful turn-stop callback. That absence is load-bearing: exceptional local paths must not pretend that a graceful upstream stop occurred.

**Verification.** Run auto-compaction queue, compaction-suite, queue-suite, interactive-compaction, concurrent-session, and queued-follow-up regression tests. In a real TTY, verify successful continuation, voluntary cancellation, unavailable cut points, retained-context failure, and queued-message behavior.

**Exit/re-evaluation.** Remove the local flow when an adopted upstream API provides lifecycle-safe between-tool-batch compaction with graceful stop semantics; review every Agent and compaction lifecycle change.

## ui-tool-presentation

**Rationale and scope.** Native tools retain consistent call/result chrome, bounded collapsed output, delayed shell progress, renderer refresh, grouped exploration rows, and keybinding-aware expansion hints without changing model-facing tool contracts.

**Upstream assumptions.** Tool rendering continues through call/result renderers with a result-aware context, while execution semantics can be integrated before presentation adaptation.

**Verification.** Run tool-execution, Bash-rendering, edit-no-full-redraw, and keybinding-hint tests. In a real TTY, cover pending, success, error, collapsed, expanded, grouped, delayed-progress, large-diff, and manual-command states.

**Exit/re-evaluation.** Remove adapters when adopted native renderer metadata and lifecycle hooks can preserve this presentation without schema or result changes; review renderer and execution changes.

## ui-bundled-themes

**Rationale and scope.** Distribution themes ship as native assets, and a narrow ANSI restoration guard keeps nested semantic spans from leaking terminal-default colors.

**Upstream assumptions.** Built-in theme enumeration and semantic foreground/background rendering remain compatible with the asset loader and nested-span guard.

**Verification.** Run theme-picker, theme-export, and syntax-highlight tests; use the theme picker and inspect nested tool hints in a real terminal.

**Exit/re-evaluation.** Remove the guard when upstream supplies equivalent nested-span behavior, and remove a theme only when this distribution no longer ships it; review theme renderer and asset changes.

## ext-bundled

**Rationale and scope.** Distribution workflow extensions use the public API while small compatibility adapters preserve selector labels, RPC wire behavior, stale-context detection, and shared path encoding. The extensions keep bounded model-facing summaries, lifecycle-safe retries and refreshes, and their own native-style renderers.

**Upstream assumptions.** `InlineExtension` registration and the Extension API remain stable; extensions do not depend on one another's internals. Rewind additionally relies on the tree-navigation leaf rules and on one `before_agent_start` event per `prompt()` rather than per queued follow-up.

**Verification.** Run extension discovery, selector, path, and each bundled extension's focused tests. In a real TTY, exercise `/reload` and `/tree` for lifecycle extensions, selector cancellation, bounded transcript expansion, retries, and shutdown.

**Exit/re-evaluation.** Remove an adapter when the public Extension API, selector API, or RPC protocol can represent the behavior directly; remove an extension only when the distribution stops shipping it. Review every affected API and lifecycle change.

## ui-terminal-output

**Rationale and scope.** A `CoalescingTerminal` adapter makes one synchronous render pass observable as one stdout write for IME stability and preserves scrollback during the active-run reading window. Preservation starts at `agent_start` and ends on the first user input after `agent_settled`; explicit mid-run toggles use one clean upstream replay. Outside that window the normal wipe-and-replay behavior remains intact.

**Upstream assumptions.** The public terminal interface permits the adapter to override writes and flush before teardown. The scrollback rewrite is deliberately guarded by the expected full-render frame: synchronized output begins with `CSI ?2026h`, may contain kitty deletes, then has `CSI 2J`, home, `CSI 3J`, CRLF-joined rows, and closes with `CSI ?2026l`. Width or height changes, kitty frames, unknown frame shapes, and shrinking transcripts use the safe upstream or bottom-anchored fallback rather than a speculative rewrite. `CSI 2J` is avoided in rewritten frames because conhost/Windows Terminal can scroll the screen into history.

The viewport-preserving flavor also relies on the private runtime field `TUI.previousViewportTop`: it must name the top transcript line and be updated after the full-render write. Validate that value before use and fall back to the bottom-anchored repaint if it is absent or invalid. This private-field and frame-shape dependency is load-bearing, not a supported pi-tui API.

**Verification.** Run coalescing-terminal and scrollback tests, including final-screen equivalence and reachable appended history. In Windows Terminal, test CJK IME caret stability, scroll up during streaming, and expand a tool result taller than the screen.

**Exit/re-evaluation.** Remove write coalescing when pi-tui makes each render pass atomic; remove scrollback rewriting when pi-tui provides equivalent safe preservation or a public hook. Review every terminal, `ProcessTerminal`, and full-render-frame change.

## ui-time-lifecycle

**Rationale and scope.** Interactive timers derive from absolute timestamps or deadlines, repaint only while their owner is active, and dispose on close, replacement, rebuild, and shutdown. This covers countdowns, animation, selector loading, relative session ages, and tree labels that change at local midnight.

**Upstream assumptions.** Selectors remain hosted through interactive mode, session-picker work stays asynchronous and callback-driven, countdown consumers use milliseconds, and the animation model remains compatible with deadline scheduling and disposal.

**Verification.** Run time-driven UI, tree selector, session selector rename/path-delete, extension selector, and status-indicator tests. In a real TTY, keep `/resume` open across a minute, cross local midnight with tree labels visible, close selectors while loading, and confirm animation redraws return to idle.

**Exit/re-evaluation.** Remove each fix when adopted upstream components provide lifecycle-safe deadline scheduling and disposal; review selector, animation, and interactive lifecycle changes.
