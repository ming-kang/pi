# Maintainer guide

These repository-only notes are excluded from the npm package.

## Architecture boundary

This repository publishes one standalone package, `@astralyn/pi`, with the `pi` executable. Runtime source is under `src/**`; it does not recreate upstream workspaces or publish another package.

AI, Agent core, Client, Protocol, and TUI behavior come from the exact published `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-client`, `@earendil-works/pi-protocol`, and `@earendil-works/pi-tui` dependencies; the experimental Chord runtime adds the exact `@earendil-works/chord` and `@earendil-works/pi-server` dependencies. Do not vendor or patch them. Core owns global lifecycle, native tool presentation, renderer integration, and configurable keybindings. Extensions are self-contained `src/extensions/**` users of the public Extension API; they do not import each other's internals. Keep functional UI with its extension and preserve tool schemas, protocols, and result structures for display-only work.

Background execution has three ownership boundaries:

- `src/core/background/service.ts` supervises invocation admission, foreground handoff, cancellation, delivery claims, and bounded retention. `history.ts` validates persisted snapshots; restoring a snapshot never restores execution or accounting ownership.
- `src/core/background/session.ts` connects supervision to the session journal and main-agent completion turns. It persists usage and results before notifying observers, retains one in-flight delivery, and quarantines late settlements. `AgentSession` supplies lifecycle pauses and acknowledges messages only after persistence; queued `nextTurn` context follows the same rule.
- `src/core/tools/shell-execution.ts` owns shell execution and output collection; the Subagent extension owns worker sessions and its concurrency gate. Executors return results and diagnostics. The native tool boundary decides whether to return a handoff or throw a foreground shell error. The `bg` extension only observes and controls these executions.

Keep execution settlement, message delivery, and history retention distinct. A wait ending does not stop execution, a returned result is not yet a persisted acknowledgement, and hiding a branch does not deliver its pending completions. Delivered history can be released and restored from the selected branch; pending results, pins, and active reads share a separate allowance within the service's total retention bound.

`src/core/background/presentation.ts` owns the bounded public projection and terminal completion-message contract. Executors publish separate output/report/error fields and source truncation flags; the session produces both the model prose and self-contained card details from those facts. The background extension owns rendering and never decodes another extension's private tool details. History uses result-record version 2; completion details use version 1. There is one decoder for each current format, no text reconstruction or migration. Accounting remains in the independent usage ledger.

## Local development

Follow [`AGENTS.md`](../AGENTS.md), then install and verify a checkout:

```bash
npm install --ignore-scripts
npm run build
npm run check
```

Run from source with `npm run dev`; append `-- --no-env` to avoid loading provider credentials. The hidden `/debug` command writes rendered TUI lines and recent model messages to `~/.pi/agent/pi-debug.log`.

Run focused tests for changed behavior before `npm run check`. Interactive work also needs a real TTY check of affected pending and settled states, collapsed and expanded output, and lifecycle commands such as `/reload` or `/tree` when relevant.

For a complete local suite, use `npm run test:isolated`, which isolates home, configuration, cache, and credentials while reusing Pi-managed `fd`/`fdfind` and `rg` from the real agent bin. The runner preflights both tools and reports one actionable error if they are unavailable. On Windows, treat focused failures as real but classify POSIX-sensitive differences; Ubuntu CI is authoritative for complete-suite release coverage. Windows process and real-TTY checks remain valuable supplemental verification.

## Further runbooks

- [Upstream synchronization](upstream.md) — adopt an exact upstream release tag and re-check local deviations.
- [Release](release.md) — irreversible package publication and tagging after synchronization.
- [`upstream.json`](upstream.json) — the recorded upstream baseline.
