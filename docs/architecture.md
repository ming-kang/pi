# Fork architecture

## Purpose

This repository is a personal Pi distribution that follows `earendil-works/pi` while maintaining a small set of coding-agent changes.

The goals are:

- keep the complete upstream monorepo;
- concentrate personal changes in `packages/coding-agent/**`;
- make native tool presentation match the desired transcript style;
- bundle personal workflow extensions and themes;
- publish only the coding-agent distribution as `@astralyn/pi`;
- avoid infrastructure that has no current use.

## Package boundary

The repository retains all upstream workspaces:

```text
packages/
├── ai/
├── agent/
├── coding-agent/
├── server/
├── storage/
└── tui/
```

Personal implementation changes belong in `packages/coding-agent/**`. The AI, agent-core, TUI, server, and storage packages follow upstream unless a concrete coding-agent requirement forces a small compatible change.

Only `@astralyn/pi` is published. It continues to depend on the upstream `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` packages.

## Core and extension boundary

Pi core is changed only for behavior that must be global:

- native tool call/result Chrome;
- generic renderer fallback;
- built-in renderer integration;
- globally configurable keybindings required by bundled UI.

Personal workflow features remain extensions even though they are statically bundled:

```text
packages/coding-agent/src/extensions/
├── deepwiki/
├── question/
├── todo/
├── rewind/
├── router/
└── statusline/
```

They are registered as hidden `InlineExtension` entries in `src/extensions/index.ts`. This keeps registration, lifecycle hooks, tools, commands, persistence, and UI local to each feature.

No `src/fork/`, shared extension framework, feature registry, or cross-extension helper layer is used.

## Configuration compatibility

The command remains `pi`, and existing Pi settings and sessions remain under `~/.pi/agent`.

Built-in extensions store their data alongside Pi's other first-class agent data:

```text
~/.pi/agent/router.json
~/.pi/agent/rewind/
```

These paths are implementation details, not a separate package dependency. The archived `pi-config` layout is not read or migrated.

## Themes

`ice-cream-dark` and `ice-cream-light` are built-in theme assets under:

```text
packages/coding-agent/src/modes/interactive/theme/
```

They are loaded by the same native theme path as `dark` and `light`, and are copied by the existing coding-agent asset build.

## Upstream synchronization

The upstream repository remains configured as `upstream`:

```bash
git fetch upstream
git merge upstream/main
```

Fork-owned files include:

- root `README.md` and `AGENTS.md`;
- root `docs/`;
- bundled extension directories;
- ice-cream theme files;
- `@astralyn/pi` package metadata and update behavior.

Most other files remain upstream-owned. The expected recurring merge hotspots are:

```text
packages/coding-agent/src/extensions/index.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/src/modes/interactive/theme/theme.ts
packages/coding-agent/src/core/tools/*.ts
packages/coding-agent/src/core/keybindings.ts
packages/coding-agent/package.json
```

Resolve those conflicts directly. Do not introduce a patch framework or duplicate upstream source to avoid normal Git merges.

## Release model

Fork releases use the upstream version plus a numeric npm prerelease revision:

```text
0.81.1-1
0.81.1-2
0.82.0-1
```

The npm registry entry for `@astralyn/pi` is the only update source. No custom update service, telemetry service, multi-package publish process, or community release workflow is maintained.
