# Distribution maintenance

This guide describes how to keep the standalone `@astralyn/pi` package aligned with upstream Pi. The repository contract in [`AGENTS.md`](../../AGENTS.md) is authoritative; publishing is covered separately in [`release.md`](release.md).

## Repository model

```text
origin    private distribution repository
upstream  earendil-works/pi monorepo
```

`main` contains a standalone package, not an upstream monorepo checkout. Upstream tags must therefore be inspected and selectively imported; never merge an upstream tag directly into `main`, because that would recreate every workspace.

## Ownership layers

| Layer | Typical paths | Policy |
|---|---|---|
| Upstream-aligned coding-agent | most of `src/**`, `test/**`, `docs/**`, `examples/**` | Import compatible changes from an upstream release tag. |
| Distribution-owned | `docs/distribution/**`, bundled personal extensions, ice-cream themes, release workflow, package identity | Preserve local design and update deliberately. |
| Hybrid | `src/core/agent-session.ts`, native tool presentation, built-in tools, keybindings, extension registration, `package.json`, `CHANGELOG.md` | Review function by function; retain upstream lifecycle semantics and local behavior. |
| Registry boundary | exact upstream AI, Agent core, and TUI dependencies | Upgrade together with the imported coding-agent release; never patch their installed files. |

Recurring hybrid hotspots include:

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

## Synchronization workflow

Synchronize only against upstream release tags, never upstream `main`. Start from a clean branch and fetch tags:

```bash
git status --short
git fetch upstream --tags
git tag --list 'v<upstream-minor>.*'
git switch -c sync/upstream-<version> main
```

Extract the upstream coding-agent subtree into a temporary directory without changing the current checkout:

```bash
tmp="$(mktemp -d)"
git archive v<version> packages/coding-agent | tar -x -C "$tmp"
```

Review `$tmp/packages/coding-agent/` against the standalone root. Import upstream changes in bounded groups:

1. Review source and tests, paying special attention to the hybrid hotspots above.
2. Update product/API documentation and examples while retaining distribution-specific references.
3. Adapt upstream package and TypeScript changes to the standalone root rather than copying monorepo-relative paths.
4. Set the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` versions published for that upstream release.
5. Run `npm install --ignore-scripts` to refresh `npm-shrinkwrap.json`, then inspect dependency and lifecycle-script changes.

Do not copy these upstream monorepo assumptions into the standalone repository:

- workspace declarations or `packages/*` paths;
- TypeScript or Vitest aliases to sibling source workspaces;
- Server, storage, model-catalog, binary, or multi-package release scripts;
- cross-package source modifications needed only by an unreleased upstream checkout.

If imported coding-agent code requires an API absent from the published upstream dependencies, stop and use a later compatible release. Do not solve the mismatch by vendoring or locally forking another package.

## Conflict policy

When reconciling upstream changes:

1. Preserve security fixes, protocol correctness, execution semantics, and public API compatibility first.
2. Keep local behavior only where it is intentionally documented and tested.
3. For native UI, integrate upstream execution changes before adapting presentation.
4. Keep model-facing output bounded and avoid schema/result changes for display-only work.
5. Prefer a small local type intersection or adapter over changing an upstream dependency API.

Git may detect many imports as renames from the historical `packages/coding-agent` path. Review content, not rename percentages.

## Dependency and lock maintenance

All direct registry dependencies are exact. When package metadata changes:

```bash
npm install --ignore-scripts
npm run check:pinned-deps
```

`npm-shrinkwrap.json` is both the development lock and the lock published with `@astralyn/pi`. Review new or changed transitive packages, platform-specific optional packages, and lifecycle scripts before accepting it. The pre-commit hook requires an explicit `PI_ALLOW_LOCKFILE_CHANGE=1` acknowledgment when committing an intentional shrinkwrap change.

## Verification

At minimum:

```bash
npm run build
npm run check
```

Run focused tests for each changed subsystem. For native transcript changes, verify pending, success, error, collapsed, and expanded states, plus `Ctrl+O`, `/reload`, and `/tree` in a real TTY. The Ubuntu CI workflow runs Build, Check, and the full test suite.

Before integrating a synchronization branch:

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

## Changelog and release ownership

- `CHANGELOG.md` is the runtime and release changelog for `@astralyn/pi`.
- `docs/**` remains structurally close to upstream coding-agent user/API documentation.
- `docs/distribution/**` records standalone architecture, bundled behavior, maintenance, and release operations.
- Dependency package changelogs are not copied; consult their upstream releases during synchronization.

After synchronization and verification, follow the [release checklist](release.md).
