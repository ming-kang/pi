# Distribution architecture

## Package and dependency boundary

This repository is one standalone npm package, `@astralyn/pi`, whose executable is `pi`. It contains the coding-agent runtime, tests, distribution-owned documentation and examples, and repository-only maintainer material; it does not carry upstream workspaces or coordinate another package's release.

AI, Agent core, and TUI behavior come from the exact published `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` dependencies. Their source is neither copied nor locally patched. A synchronization that adopts APIs from a new coding-agent release updates the compatible exact dependency versions and the shrinkwrap together.

## Runtime and extension boundary

Core owns behavior that must be global: agent/session lifecycle, native tool call and result presentation, built-in renderer integration, context-safety checks, and globally configurable keybindings. Native tool UI remains the default; presentation metadata stays local to the coding agent rather than changing upstream tool contracts.

Built-ins are registered as hidden `InlineExtension` entries. `llama.cpp` is the upstream-aligned built-in. The seven distribution-owned workflow extensions are `deepwiki`, `question`, `rewind`, `router`, `statusline`, `subagent`, and `todo`. Each uses the public Extension API, owns its own functional UI, and remains independent of other extensions; there is no shared Fork framework or cross-extension internal API.

## Configuration and assets

The normal Pi configuration and session location remains `~/.pi/agent`; no distribution-specific configuration layer is introduced. Extensions keep their first-class data with normal agent data, including router and rewind state.

Native themes and interactive assets are package assets. The ice-cream themes live with the interactive themes and are copied with the other runtime assets into the published build. Theme and extension UI use semantic theme helpers so user-selected themes remain authoritative.

## Documentation and baseline ownership

`README.md`, `docs/**`, and `examples/**` are distribution-owned product material, informed by upstream releases but rewritten for behavior this package actually adopts. `maintainers/**` is repository-only.

[`upstream.json`](upstream.json) owns the reviewed upstream baseline identity, exact runtime dependency record, owned-path registry, delta metadata, and budget. [`delta.md`](delta.md) explains the human rationale and re-verification of those registered differences. The release-tag procedure is in [upstream-sync.md](upstream-sync.md); release versioning and publication are in [release.md](release.md).
