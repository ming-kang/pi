# Upstream synchronization

This guide describes how to keep the standalone `@astralyn/pi` package aligned with upstream Pi. The repository contract in [`AGENTS.md`](../AGENTS.md) is authoritative; publishing is covered separately in [`release.md`](release.md).

## Repository model

```text
origin    private distribution repository
upstream  earendil-works/pi monorepo
```

`main` contains a standalone package, not an upstream monorepo checkout. Upstream tags must therefore be inspected and selectively imported; never merge an upstream tag directly into `main`, because that would recreate every workspace.

## Baseline branch and delta registry

The local `upstream-extract` branch is the reviewed upstream baseline: an orphan commit whose tree is the root-mapped extraction of `packages/coding-agent` from the tag recorded in [`upstream.json`](upstream.json). It is never merged into `main` and never pushed as a development branch; it exists so the fork delta is a first-class Git object:

```bash
npm run diff:upstream                        # classified per-file delta report
npm run diff:upstream -- --check             # fail on unregistered drift or stale registrations
node scripts/diff-upstream.mjs --update-baseline   # (re)create upstream-extract from the reviewed tag
git diff upstream-extract HEAD -- src/       # raw source delta against the baseline
```

[`upstream.json`](upstream.json) is the authoritative per-path registry. Every difference from the baseline must be classified there as `localOnly` (distribution-owned path), `hybrid` (upstream file with local modifications), or `dropped` (upstream path intentionally not shipped). `diff:upstream` verifies the registry in both directions: unregistered differences and registrations that no longer match any difference both fail `--check`. The rationale for each delta unit is documented in [`delta.md`](delta.md).

## Ownership layers

| Layer | Typical paths | Policy |
|---|---|---|
| Upstream-aligned coding-agent | most of `src/**` and `test/**` | Import compatible changes from an upstream release tag. |
| Distribution-owned product documentation | `README.md`, `docs/**`, `examples/**` | Review upstream changes as semantic input, then maintain local wording and examples for behavior this distribution adopts. Never overwrite `docs/**` as a mirror. `docs/bundled/**` covers shipped distribution features. |
| Repository-only maintainer documentation | `AGENTS.md`, `maintainers/**` | Maintain for repository operation; exclude `maintainers/**` from npm. |
| Distribution-owned runtime and operations | bundled personal extensions, ice-cream themes, release workflow, package identity | Preserve local design and update deliberately. |
| Hybrid | `src/core/agent-session.ts`, native tool presentation, built-in tools, keybindings, extension registration, `package.json`, `CHANGELOG.md` | Review function by function; retain upstream lifecycle semantics and local behavior. |
| Registry boundary | exact upstream AI, Agent core, and TUI dependencies | Upgrade together with the imported coding-agent release; never patch their installed files. |

The complete hybrid file list is the `hybrid` array in [`upstream.json`](upstream.json); `npm run diff:upstream` prints it as verified against the baseline. [`delta.md`](delta.md) explains what each hybrid file changes and how to re-verify it after a synchronization.

## Synchronization workflow

Synchronize only against upstream release tags, never upstream `main`. Start from a clean branch and fetch tags:

```bash
git status --short
git fetch upstream --tags
git tag --list 'v<upstream-minor>.*'
git switch -c sync/upstream-<version> main
```

Review what upstream changed since the reviewed baseline directly against the baseline branch:

```bash
git diff --stat upstream-extract "v<version>:packages/coding-agent"
git diff upstream-extract "v<version>:packages/coding-agent" -- src/core/
```

For browsing complete files, an extraction into a temporary directory still works:

```bash
tmp="$(mktemp -d)"
git archive v<version> packages/coding-agent | tar -x -C "$tmp"
```

Import upstream changes in bounded groups:

1. Review source and tests, paying special attention to the `hybrid` files registered in [`upstream.json`](upstream.json).
2. Inspect that release tag's changes to its coding-agent `README.md`, `docs/**`, and `examples/**` as semantic input alongside the source changes.
3. Adapt adopted source, package, and TypeScript changes to the standalone root rather than copying monorepo-relative paths.
4. Rewrite affected local user/API documentation for the behavior actually adopted here, preserving distribution package names, routes, and defaults. Update `docs/bundled/**` for affected shipped distribution features and adapt local examples where needed.
5. Set the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` versions published for that upstream release.
6. Run `npm install --ignore-scripts` to refresh `npm-shrinkwrap.json`, then inspect dependency and lifecycle-script changes.

Upstream README, documentation, and examples are not files to mirror or bulk-copy. Their changes describe intended upstream behavior; compare that intent with the source and APIs this distribution actually adopts, then rewrite local documentation so it remains accurate for `@astralyn/pi`. Local organization may intentionally differ from upstream.

Only after reviewing source, `README.md`, `docs/**`, and `examples/**` for the tag should maintainers update [`upstream.json`](upstream.json) with the reviewed tag, commit, coding-agent version, and exact runtime dependency versions. Do not advance this record as a planning marker or after a source-only import.

After advancing `reviewedTag`, move the baseline branch and re-verify the delta registry:

```bash
node scripts/diff-upstream.mjs --update-baseline
npm run diff:upstream -- --check
```

Newly adopted upstream files that gained local modifications, new distribution-owned files, and newly dropped upstream paths must be registered in `upstream.json` and explained in [`delta.md`](delta.md) before the check passes.

`reviewedTag` records the upstream release whose inputs were reviewed; it is not necessarily an ancestor of `main`. This standalone branch selectively imports and rewrites content instead of merging upstream monorepo history, so Git ancestry must not be used to infer the review baseline.

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

## Changelog and documentation ownership

- `CHANGELOG.md` is the runtime and release changelog for `@astralyn/pi`.
- `docs/**` is distribution-owned user/API documentation and is rewritten for adopted behavior rather than maintained as an upstream mirror.
- `docs/bundled/**` documents features shipped by this distribution.
- `maintainers/**` records repository-only architecture, development, synchronization, and release operations and is excluded from npm.
- Dependency package changelogs are not copied; consult their upstream releases during synchronization.

After synchronization and verification, follow the [release checklist](release.md).
