# Upstream synchronization

Follow [AGENTS.md](../AGENTS.md) and the ownership rules in [Architecture](architecture.md). A synchronization adopts one exact upstream release; [Release](release.md) publishes it.

## Baseline and concern ledger

`upstream.json` records the upstream repository, release tag and commit, source subtree, and root-mapped source tree. Every comparison is against that tree, never a branch tip.

`concerns.json` groups every modified or dropped upstream path under the concerns that need it. Upstream does not generally accept contributor PRs, so treat every deviation as permanent unless it names an observable retirement signal.

| Field | Meaning |
| --- | --- |
| `id` | Stable kebab-case name. |
| `why` | One sentence; durable explanations belong in [Architecture](architecture.md). |
| `paths[].path` | A deviating path; directory claims end in `/`. Several concerns may claim one path. |
| `paths[].rewrite` | Why the patch cannot be thinner, for a `src/` path that deletes more than 8 upstream lines or re-indents more than 10. |
| `tests` | Covering tests; `npm run sync -- --verify` runs them when upstream touches the concern. |
| `watch` | Optional observable retirement signal. |

`npm run diff:upstream -- --check`, which the commit hook runs against the index, fails when:

- a modified or dropped upstream path has no claim, or a claim matches no deviation;
- the ledger schema is invalid or a listed test does not exist;
- the baseline, the `@earendil-works/*` pins, and the shrinkwrap disagree;
- a file still carries a `<<<<<<< distribution` or `>>>>>>> upstream` conflict marker.

A `rewrite` reason that is missing or no longer needed prints a note, not a failure; fix it with the next ledger edit. `npm run diff:upstream` with no flag prints the complete report, including each modified source path's conflict surface.

## Keeping deviations small

A deviation earns its maintenance cost only while it does something upstream does not. Retire one as soon as upstream supplies a similar mechanism, even when the result is not identical: prefer upstream's option name, lifecycle, and defaults over an equivalent local variant, and express a policy that must stay as a conversion in front of upstream's mechanism rather than a replacement for it. `compaction/settings.ts` is the reference example — it converts `triggerPercent` into upstream's `reserveTokens` so compaction, its tests, and its SDK signature stay upstream's.

Do not move upstream code into a distribution module so that both can share it. The move deletes upstream lines, which conflicts whenever upstream edits them, and the shared copy drifts from the original without any signal. Leave upstream's code where it is and pass a reference to it, or add a line that calls the distribution code. `sdk.ts` and `ContextSnapshotCapture` are the reference example. Likewise put a distribution test in a distribution-owned file rather than appending it to an upstream test file, unless it changes what an existing upstream test asserts.

Wholly rewritten documentation pages are the exception. `docs/**` is distribution-owned, and a rewrite that documents real behavior stays even when upstream later edits the same page: keep this distribution's prose and port only upstream's factual changes, which is why synchronization leaves `docs/` for porting by hand.

## Runbook

1. **Start** from a clean `main`:

   ```bash
   npm run sync -- v<version>
   ```

   This fetches the release, creates `sync/upstream-v<version>`, three-way merges every upstream change against the recorded baseline, advances `upstream.json`, and moves all `@earendil-works/*` pins to `<version>` through npm (with a release-age exception scoped to that install). It prints merged, added, deleted, skipped (dropped here), and conflicting paths; the review paths it leaves for porting by hand (`README.md`, `CHANGELOG.md`, `docs/`, and the root manifests) with the command that shows each upstream change; the concerns whose paths upstream changed; and the upstream release notes link.

2. **Adopt.** Read the release notes and the changes. Resolve conflict markers, remove added paths that do not apply with `git rm -f`, and decide each binary file kept at this distribution's version. Port upstream's factual changes into the review paths, registering new docs pages in `docs/docs.json`. Re-review each listed concern, update `concerns.json`, add user-visible changes to `CHANGELOG.md` under `[Unreleased]`, and review any new dependency's scope per [Dependency maintenance](dependencies.md). Verify interactive changes in a real terminal per [Interactive testing](interactive-testing.md).

3. **Verify and commit:**

   ```bash
   npm run sync -- --verify
   ```

   This registers hand-ported upstream files with `git add --intent-to-add` (git otherwise treats an untracked replacement as a deletion plus a separate file), then runs format, `npm run check`, the ledger check, and the tests of every concern upstream touched. Stage the synchronization's paths, review the staged diff, and commit as `feat: sync upstream v<version>`. The commit body is the synchronization record: adoption decisions (adopt, adapt, defer, not applicable) and how each conflict was resolved. A lockfile change limited to `@earendil-works/*` packages needs no acknowledgement.

4. **Land and release:**

   ```bash
   git switch main
   git merge --ff-only sync/upstream-v<version>
   git branch -d sync/upstream-v<version>
   npm run release
   ```

   The release tag runs the complete Ubuntu CI before anything is published, so the synchronization branch is not pushed. If `main` diverged, rebase the branch and rerun `--verify` rather than forcing the merge.
