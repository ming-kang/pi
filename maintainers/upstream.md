# Upstream synchronization

Follow [AGENTS.md](../AGENTS.md) and the ownership rules in [Architecture](architecture.md). A synchronization adopts one exact upstream release; [Release](release.md) publishes it.

## Baseline and concern ledger

- **`upstream.json`:** Records the upstream repository, release tag, commit hash, and source subtree. All diffs compare against this root-mapped source tree, never a branch tip.
- **`concerns.json`:** Tracks every local deviation from upstream. Each entry groups modified or dropped files under a durable rationale.

| Field | Purpose |
| --- | --- |
| `id` | Stable kebab-case concern identifier. |
| `why` | Single sentence rationale (architectural context belongs in [Architecture](architecture.md)). |
| `paths[].path` | Deviating path. Directory paths end in `/`. Multiple concerns may claim the same path. |
| `paths[].rewrite` | Required for `src/` changes that delete >8 upstream lines or re-indent >10 lines. |
| `tests` | Covering test paths executed by verification gates when upstream touches this concern. |
| `watch` | Optional observable retirement condition. |

`npm run diff:upstream -- --check` runs on pre-commit and fails if:
- An upstream-deviating path lacks a claim (or a claim references an unchanged path).
- The ledger schema is invalid or a referenced test file is missing.
- The baseline tree, `@earendil-works/*` dependency pins, and `npm-shrinkwrap.json` disagree.
- Any conflict markers (`<<<<<<<` / `>>>>>>>`) remain.

## Keeping deviations small

A deviation earns its maintenance cost only while it provides capabilities upstream lacks. Retire claims as soon as upstream provides comparable functionality.

- **Prefer front-end conversion over replacement:** Transform distribution configuration into upstream types rather than swapping core implementations (e.g. converting `triggerPercent` to `reserveTokens`).
- **Avoid moving upstream code:** Do not extract upstream code into distribution helpers; this creates silent divergence and merge conflicts. Keep upstream code in place and inject hooks or pass references.
- **Isolate tests:** Put distribution tests in dedicated files unless modifying upstream test assertions.
- **Documentation exception:** `docs/**` is distribution-owned. Port factual upstream changes into our existing prose rather than replacing entire pages.

## Managing concerns in daily work

- **Claiming a new deviation:** When modifying an upstream file, add its path and covering tests to an existing concern in `concerns.json`, or create a new entry if addressing a distinct capability.
- **Retiring a deviation:** When upstream adopts a feature, remove the claim from `concerns.json`, revert the local patch to match upstream baseline, and remove the entry from the ledger.

## Synchronization runbook

### 1. Start synchronization
From a clean `main` branch:

```bash
npm run sync -- v<version>
```

This automated step:
- Fetches the upstream release tag.
- Creates branch `sync/upstream-v<version>`.
- Merges upstream changes against the baseline in `upstream.json`.
- Bumps `@earendil-works/*` dependency pins to match `<version>`.
- Prints paths requiring manual review (docs, dropped files, conflicting files).

### 2. Adopt changes
- **Resolve conflicts:** Fix merge conflicts; remove non-applicable added files with `git rm -f`.
- **Port manual changes:** Port upstream fixes into distribution-owned replacements and documentation. Register newly added docs in `docs/docs.json`.
- **Review concerns:** Check listed touched concerns, update `concerns.json`, and add user-facing changes to `CHANGELOG.md` under `## [Unreleased]`.
- **Verify UI:** Check interactive changes in a terminal per [Interactive testing](interactive-testing.md).

### 3. Verify and commit

```bash
npm run sync -- --verify
```

This command runs `git add --intent-to-add`, formats code, runs `npm run check`, validates the concern ledger, and executes tests for all touched concerns.

Commit using Conventional Commits:
```bash
git commit -m "feat: sync upstream v<version>"
```
Document adoption decisions (adopt, adapt, defer) and conflict resolutions in the commit body.

### 4. Land and release

```bash
git switch main
git merge --ff-only sync/upstream-v<version>
git branch -d sync/upstream-v<version>
npm run release
```
