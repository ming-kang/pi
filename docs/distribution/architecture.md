# Distribution architecture

## Purpose

This repository is a standalone personal distribution of Pi's coding-agent package. Its goals are to:

- maintain only code that ships in `@astralyn/pi`;
- consume AI, Agent core, and TUI from upstream npm releases;
- keep native tool presentation, bundled workflow extensions, themes, and context-safety behavior local to this package;
- avoid cross-workspace source changes and multi-package release coordination.

## Package boundary

The repository root is the npm package:

```text
src/                 coding-agent runtime
 test/                coding-agent tests
 docs/                product and API documentation
 examples/            SDK and extension examples
 docs/distribution/   distribution-owned documentation
 package.json          @astralyn/pi
 npm-shrinkwrap.json   development and published dependency lock
```

The runtime boundary is explicit and versioned in `package.json`:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`

These are exact registry dependencies. Their source is not copied into this repository and local verification resolves the same published packages that npm users install. A coding-agent synchronization that needs new upstream APIs must update all compatible dependency versions in the same change.

Presentation-only metadata such as `toolGroup` uses coding-agent-local intersection types rather than changing `AgentTool`. The long-tool-loop compaction implementation uses the upstream stateful Agent's public `prepareNextTurnWithContext` callback for successful same-run continuation. Exceptional fail-closed paths are represented locally as explicit error/aborted lifecycle boundaries because the stateful Agent does not expose its low-level graceful turn-stop callback.

## Core and extension boundary

Pi core changes are reserved for behavior that must be global:

- native tool call/result chrome and generic renderer fallback;
- built-in renderer integration;
- context-safety checks such as between-tool-batch auto-compaction;
- globally configurable keybindings required by bundled UI.

Personal workflow features remain self-contained extensions:

```text
src/extensions/
├── deepwiki/
├── question/
├── todo/
├── rewind/
├── router/
├── statusline/
└── subagent/
```

They are registered as hidden `InlineExtension` entries in `src/extensions/index.ts`. No shared Fork framework, feature registry, or cross-extension internal API is used.

## Configuration compatibility

The command remains `pi`, and settings and sessions remain under `~/.pi/agent`. Built-in extensions store their first-class data alongside the normal agent data, including:

```text
~/.pi/agent/router.json
~/.pi/agent/rewind/
```

No separate Fork configuration layer is introduced.

## Themes

`ice-cream-dark` and `ice-cream-light` are native theme assets under `src/modes/interactive/theme/`. The normal package build copies all theme JSON files into `dist`.

## Upstream synchronization

The `upstream` remote still points to `earendil-works/pi`, but upstream monorepo tags are not merged into this standalone branch. Synchronization extracts and reviews only `packages/coding-agent/**` from an upstream release tag, maps that subtree to the repository root, and updates exact registry dependency versions. See [maintenance.md](maintenance.md).

Recurring review hotspots are:

```text
src/extensions/index.ts
src/core/agent-session.ts
src/core/keybindings.ts
src/core/tools/*.ts
src/modes/interactive/components/tool-execution.ts
src/modes/interactive/interactive-mode.ts
src/modes/interactive/theme/theme.ts
package.json
CHANGELOG.md
```

## Release model

Only `@astralyn/pi` is published. Fork releases track the upstream `major.minor` line while using the patch number for this distribution's release sequence:

```text
upstream 0.82.x -> Fork 0.82.0, 0.82.1, 0.82.2, ...
upstream 0.83.x -> Fork 0.83.0, 0.83.1, 0.83.2, ...
```

Tags use `pi-v<full-version>` so they do not collide with upstream `v<version>` tags. Ubuntu CI verifies the standalone package, and the manually dispatched publish workflow uploads the repository root with npm Trusted Publishing. No other package, binary release flow, model catalog, or update service is maintained here.
