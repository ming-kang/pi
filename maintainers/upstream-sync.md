# Upstream synchronization

Synchronize this standalone package only from an upstream release tag. The repository contract in [`AGENTS.md`](../AGENTS.md) applies throughout; [release.md](release.md) starts only after synchronization is complete.

## Baseline authority

`maintainers/upstream.json` is authoritative for the reviewed baseline. Its `baseline.tag` identifies the release reviewed, and its `baseline.sourceTree` is the canonical root-mapped coding-agent tree used by the delta tool. The tag's recorded `sourceSubtree` and `sourceTree` must agree when the tag is available.

`upstream-extract` is an optional derived cache, not a baseline. It can make a Git-object diff convenient, but it never authorizes a comparison or a manifest update. Likewise, Git ancestry and `HEAD` do not identify the reviewed baseline. `npm run diff:upstream` always compares the current worktree—including staged changes, unstaged changes, and nonignored untracked files—against the manifest's canonical source tree.

## 1. Select and inspect a release tag

Start from a clean synchronization branch, fetch upstream tags, and select a release tag rather than `upstream/main`:

```bash
git status --short
git fetch upstream --tags
git switch -c sync/upstream-<version> main
export TARGET_TAG=v<version>
```

Read the current manifest values and resolve both comparison trees. The target must be the coding-agent subtree tree from the selected tag; do not compare against `HEAD` or `upstream-extract`.

```bash
BASELINE_TREE="$(node -p "require('./maintainers/upstream.json').baseline.sourceTree")"
SOURCE_SUBTREE="$(node -p "require('./maintainers/upstream.json').baseline.sourceSubtree")"
TARGET_COMMIT="$(git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}")"
TARGET_TREE="$(git rev-parse --verify "$TARGET_COMMIT:$SOURCE_SUBTREE")"
git cat-file -t "$BASELINE_TREE"
git cat-file -t "$TARGET_TREE"
git diff --stat "$BASELINE_TREE" "$TARGET_TREE"
git diff "$BASELINE_TREE" "$TARGET_TREE" -- src/ test/
git diff "$BASELINE_TREE" "$TARGET_TREE" -- README.md docs/ examples/
```

Inspect the target tree's complete source and test changes. Also review its `README.md`, `docs/**`, and `examples/**` as semantic input: source behavior, public API changes, and examples together determine what this distribution adopts and how its own product documentation should read. Do not mirror upstream documentation or examples into this repository.

Triage every relevant change as **adopt**, **defer**, or **not applicable**. Keep this temporary per-release triage in the synchronization branch or commit review notes, not in permanent maintainer documentation.

## 2. Adopt compatible changes

Apply selected coding-agent changes to the standalone root, preserving upstream security, protocol, execution, and public-API semantics before local presentation or workflow behavior. Do not import monorepo assumptions such as workspaces, sibling source aliases, non-coding-agent packages, or unreleased dependency APIs. If the target behavior needs an API unavailable from the published exact runtime dependencies, choose a compatible release instead of vendoring or patching a dependency.

Update local tests and rewrite distribution-owned README, documentation, and examples for the behavior actually adopted. Keep bundled-feature documentation accurate when a shipped extension or native UI changes.

## 3. Update exact dependencies and the shrinkwrap

After choosing the adopted release and before changing the manifest, update the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` dependency values in `package.json` to compatible published versions. Then regenerate and review the shrinkwrap in this order:

```bash
npm install --ignore-scripts
npm run check:pinned-deps
```

Confirm the exact runtime versions in `package.json`, the shrinkwrap root, and the installed shrinkwrap entries agree. Review all dependency, transitive, optional-platform, and lifecycle-script changes. The manifest is not a planning marker: do not advance it until the selected source, tests, product documentation, examples, exact dependencies, and shrinkwrap are all final.

## 4. Advance the manifest last and refresh the cache

As the last synchronization edit, update `maintainers/upstream.json` with the selected tag, commit, coding-agent version, source subtree, resolved `TARGET_TREE`, exact runtime dependency versions, and any final ownership or delta-registry changes. When an approved delta is added or expanded, also update `maintainers/delta.md` with its durable rationale; keep exact paths and machine fields only in the manifest. The target tag's subtree tree—not a branch tip or cache tree—is the value for `baseline.sourceTree`.

Only after that edit, refresh the optional cache and verify the current worktree boundary:

```bash
node scripts/diff-upstream.mjs --update-baseline
npm run diff:upstream -- --check
```

The update command creates or moves `upstream-extract` to the manifest's root-mapped canonical tree. The check rejects unregistered drift, stale registrations, a stale cache, invalid baseline/dependency agreement, and budget mismatches.

## 5. Verify and hand off

Run focused tests for every changed subsystem, use a real TTY for affected interactive states, then run the package checks:

```bash
npm run build
npm run check
npm run diff:upstream -- --check
git status --short
```

Resolve every boundary failure before handoff. The completed branch contains the adopted release-tag work; follow [release.md](release.md) only when it is ready to publish.
