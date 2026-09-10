# Architecture

The repository contract is [AGENTS.md](../AGENTS.md). This page owns durable architecture explanations; operational commands belong in the linked runbooks.

## Dependency boundary

Dependency provenance, exact version, and installation scope are separate requirements. Always consume the upstream libraries from their published npm packages. Put libraries needed by shipped JavaScript or public declarations in `dependencies`; put libraries used only by excluded source development and tests in `devDependencies`. Keep both exactly pinned and regenerate the shrinkwrap when either scope or version changes.

| Current direct consumers | Scope | Reason |
| --- | --- | --- |
| Pi AI, Agent core, TUI | Production | Stable SDK, tools, and interactive runtime. |
| Chord, Client, Protocol, Server | Development | This repository imports them only under `src/client/`, `src/experimental/`, and `src/cli/experimental/`, all excluded from the build. |

Chord remains a production transitive dependency of Agent core; moving this repository's direct declaration does not remove or replace that upstream dependency. Reassess scope when consumers change. The baseline checker validates the consumed upstream libraries across both sections; it does not prescribe their scope. The installed-package verifier uses the production declarations and installs with development dependencies omitted.

Experimental `client` and `experimental/plugin` subpaths expose only the `source` condition. The durable server is POSIX-only. Plugin external resolution additionally recognizes `@astralyn/pi/experimental/plugin`; the source resolver uses the standalone checkout depth.

## Ownership

Core owns global lifecycle, native tool presentation, renderer integration, and configurable keybindings. Extensions are independent public Extension API consumers. Keep tool schemas, execution protocols, and model results stable during presentation work. Only `src/extensions/llama` comes from upstream; the other bundled extensions are distribution additions.

Background execution has three ownership boundaries:

- `src/core/background/service.ts` supervises invocation admission, foreground handoff, cancellation, delivery claims, and bounded retention. `history.ts` validates persisted snapshots; restoring a snapshot never restores execution or accounting ownership.
- `src/core/background/session.ts` connects supervision to the session journal and main-agent completion turns. It persists usage and results before notifying observers, retains one in-flight delivery, and quarantines late settlements. `AgentSession` supplies lifecycle pauses and acknowledges messages only after persistence; queued `nextTurn` context follows the same rule.
- `src/core/tools/shell-execution.ts` owns shell execution and output collection; the Subagent extension owns worker sessions and its concurrency gate. Executors return results and diagnostics. The native tool boundary decides whether to return a handoff or throw a foreground shell error. The `bg` extension only observes and controls these executions.

Keep execution settlement, message delivery, and history retention distinct. A wait ending does not stop execution, a returned result is not yet a persisted acknowledgement, and hiding a branch does not deliver its pending completions. Delivered history can be released and restored from the selected branch; pending results, pins, and active reads share a separate allowance within the service's total retention bound.

Foreground shell history has its own quota, separate from background shell tasks and all Subagent groups. Runtime eviction and snapshot restoration use the same classification and per-history limit. The total retention bound includes both histories and the protected-record allowance; restoring history never acquires execution, accounting or cleanup ownership. The `/bg` panel hides settled foreground shells but keeps completed foreground Subagent groups inspectable.

`src/core/background/presentation.ts` owns the bounded public projection and terminal completion-message contract. Executors publish separate output/report/error fields and source truncation flags; the session produces both the model prose and self-contained card details from those facts. The background extension owns rendering and never decodes another extension's private tool details. History uses result-record version 2; completion details use version 1. There is one decoder for each current format, no text reconstruction or migration. Accounting remains in the independent usage ledger.

Background context is consumed only after persistence. Tree navigation releases delivered off-branch history while protecting pending completions. Merge upstream changes to `agent-session*.ts`, `tools/bash.ts`, `tools/output-accumulator.ts`, and `usage-totals.ts` around that wiring.

## Synchronization-sensitive behavior

- **esbuild bundled executables (distribution-only build step):** `scripts/build-bundle.mjs` overwrites the tsc-built `dist/cli.js` and `dist/rpc-entry.js` with self-contained esbuild bundles (plus `dist/image-resize-worker.js`) so cold starts read one file instead of hundreds — critical on native Windows, where Defender real-time scanning made every first launch slow. The bundles define `PI_BUNDLED_NODE` (upstream's own embedded-modules switch in `src/core/extensions/loader.ts`), register OAuth flows via `@earendil-works/pi-ai/bun-oauth`, and keep the native/WASM dependencies external. Upstream has no equivalent step; when upstream changes the executable entrypoints, the extension loader's bundled-mode branch, or the image-resize worker layout, re-verify `npm run build:bundle` and `npm run verify:package-install`.
- **Mid-turn compaction (high risk):** Context is checked after a completed tool batch and before queued steering or follow-up work reaches the next provider request. Safe compaction continues the same run; unsafe retained context, aborts, and failures stop at an explicit lifecycle boundary. Do not simulate a graceful upstream turn stop where the Agent API does not provide one. Exercise continuation, cancellation, unavailable cut points, retained-context failure, and queued work in focused tests and a real TTY.
- **Native tool presentation (high risk):** Keep native call/result chrome, bounded collapsed output, renderer refreshes, and keybinding-aware expansion hints without changing tool schemas, execution protocols, or model-facing results. Verify the affected pending, success, error, collapsed, expanded, grouped, and delayed-progress states in focused tests and a real TTY.
- **Platform and time-sensitive UI:** Keep Windows shell normalization narrow, and ensure interactive timers and selectors derive from deadlines, repaint only while active, and dispose on replacement or shutdown. Re-check Windows process behavior and real-TTY lifecycle interactions after upstream changes.
