# Fork maintenance

This document describes how to keep the `@astralyn/pi` distribution aligned with `earendil-works/pi` without losing Fork-owned behavior. The repository contract remains authoritative in [`AGENTS.md`](../AGENTS.md); the release procedure is separate in [`release.md`](release.md).

## Repository model

The repository uses two remotes:

```text
origin    Fork repository
upstream  earendil-works/pi
```

`main` is the stable Fork branch. Published Fork history is merged, not rebased or force-pushed. Upstream synchronization is performed on a temporary integration branch so an incomplete merge never destabilizes `main`.

## Ownership layers

Treat files according to ownership rather than choosing one side of every conflict mechanically.

| Layer | Typical paths | Merge policy |
|---|---|---|
| Upstream-owned | `packages/ai/**`, `packages/tui/**`, `packages/storage/**`, most of `packages/agent/**` and `packages/server/**` | Prefer upstream behavior; preserve only documented compatibility seams. |
| Fork-owned | Root `README.md`, `AGENTS.md`, `docs/**`, bundled personal extensions, ice-cream themes, Fork release workflow and package identity | Preserve the Fork design, then incorporate relevant upstream facts or API changes. |
| Hybrid | Native tool presentation, `interactive-mode.ts`, built-in tool renderers, keybindings, extension registration, package metadata and changelogs | Resolve manually. Keep upstream execution and lifecycle semantics, then adapt the Fork presentation or integration layer. |

The recurring hybrid hotspots are:

```text
packages/agent/src/types.ts
packages/coding-agent/src/extensions/index.ts
packages/coding-agent/src/core/keybindings.ts
packages/coding-agent/src/core/tools/*.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/package.json
packages/coding-agent/CHANGELOG.md
packages/server/package.json
```

## Synchronization workflow

Start from a clean `main`, refresh remote references, and create an integration branch:

```bash
git status --short
git fetch upstream --tags
git switch -c sync/upstream-<version> main
git merge upstream/main
```

If the merge should not continue, use `git merge --abort`. Do not repair a failed integration with destructive resets, a forced update of `main`, or a rewritten published history.

When resolving conflicts:

1. Preserve security fixes, protocol correctness, execution semantics, and upstream API compatibility first.
2. For upstream-owned files, begin from the upstream implementation and reapply only required Fork compatibility.
3. For Fork-owned files, retain the Fork purpose while updating stale upstream references.
4. For hybrid files, integrate behavior function by function. Do not accept an entire `ours` or `theirs` version without reviewing the opposite diff.
5. Keep model-facing output bounded and do not change tool schemas or result protocols for presentation-only conflicts.

A useful local aid for recurring textual conflicts is:

```bash
git config rerere.enabled true
```

Recorded resolutions must still be reviewed after Git reapplies them.

## Compatibility seams outside coding-agent

The Fork does not develop a separate Server product, but the retained upstream Server workspace must compile against the renamed coding-agent package.

Maintain these invariants:

- `packages/server` keeps its upstream package name and implementation;
- `packages/server/package.json` depends on the exact current `@astralyn/pi` version;
- Server type and runtime imports use `@astralyn/pi`;
- RPC process resolution uses `@astralyn/pi/rpc-entry`;
- `npm run check:fork-versions` passes.

Likewise, small `packages/agent` changes such as optional presentation metadata are compatibility seams, not ownership of the Agent package. If upstream introduces an equivalent API, prefer the upstream shape and adapt coding-agent rather than maintaining duplicate concepts.

## Generated dependency files

When an upstream merge changes package metadata or dependencies, accept the upstream dependency intent first, restore the Fork package identity, and regenerate rather than hand-edit generated lock data:

```bash
npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent
```

Review generated diffs before committing. Server dependency checks and coding-agent install-lock checks are part of `npm run check`.

## Verification

At minimum, run:

```bash
npm run check
```

Also run focused tests for every changed subsystem. For native transcript changes, verify pending, success, error, collapsed, and expanded states, plus `Ctrl+O`, `/reload`, and `/tree` in a real TTY. Ubuntu CI remains the release gate for Build, Check, and Test.

Before integrating the synchronization branch, inspect its scope:

```bash
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

If `main` has not moved, integrate the verified branch with a fast-forward:

```bash
git switch main
git merge --ff-only sync/upstream-<version>
git branch -d sync/upstream-<version>
```

## Security updates

Prefer a complete upstream synchronization when a security fix depends on adjacent API, dependency, or generated-data changes. Cherry-pick an isolated upstream security commit only for an urgent release, record its upstream commit ID, and remove the special-case delta when the next full synchronization includes it.

Security and correctness take precedence over Fork styling. Reapply visual behavior around the fixed upstream implementation rather than retaining vulnerable execution code to avoid a UI regression.

## Changelog and release ownership

- `packages/coding-agent/CHANGELOG.md` is the runtime and release changelog for `@astralyn/pi`.
- Other workspace changelogs primarily follow their upstream packages; add Fork entries there only when the Fork actually changes that workspace API.
- Root `docs/**` records Fork architecture, maintenance, bundled behavior, and release operations.
- `packages/coding-agent/docs/**` remains the user and API documentation set and should stay structurally close to upstream.

After synchronization and verification, follow the separate [`release checklist`](release.md) when publishing a new Fork revision.
