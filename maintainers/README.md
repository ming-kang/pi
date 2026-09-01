# Maintainer guide

These repository-only notes are excluded from the npm package.

## Architecture boundary

This repository publishes one standalone package, `@astralyn/pi`, with the `pi` executable. Runtime source is under `src/**`; it does not recreate upstream workspaces or publish another package.

AI, Agent core, Client, Protocol, and TUI behavior come from the exact published `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-client`, `@earendil-works/pi-protocol`, and `@earendil-works/pi-tui` dependencies. Do not vendor or patch them. Core owns global lifecycle, native tool presentation, renderer integration, and configurable keybindings. Extensions are self-contained `src/extensions/**` users of the public Extension API; they do not import each other's internals. Keep functional UI with its extension and preserve tool schemas, protocols, and result structures for display-only work.

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
