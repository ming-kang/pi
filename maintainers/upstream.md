# Upstream synchronization

Follow [AGENTS.md](../AGENTS.md) and the ownership rules in [Architecture](architecture.md). Synchronization adopts an exact upstream release; [publication](release.md) is a separate operation.

## Baseline and concern ledger

`upstream.json` records the repository, exact release tag/commit, source subtree, and root-mapped source tree. Compare against that tree, never a branch tip.

`concerns.json` groups every modified or dropped upstream path under the concerns that need it. Upstream does not generally accept contributor PRs, so treat every deviation as permanent unless it names an observable retirement signal.

| Field | Meaning |
| --- | --- |
| `id` | Stable kebab-case name. |
| `why` | One sentence; durable explanations belong in [Architecture](architecture.md). |
| `paths[].path` | A deviating path; directory claims end in `/`. Several concerns may claim one path. |
| `paths[].rewrite` | Required when the path measures as `rewrite`: why the patch cannot be thinner. |
| `tests` | Optional covering tests. |
| `watch` | Optional observable retirement signal. |

`--check` fails when:

1. a modified or dropped upstream path has no claim, or a claim matches no deviation;
2. a listed test path does not exist;
3. an `id` is not unique kebab-case;
4. a path measures as `rewrite` without a `rewrite` reason, or a reason remains on a path that no longer measures as `rewrite`;
5. a file still carries a conflict marker that `--apply` wrote, a line beginning with `<<<<<<< distribution` or `>>>>>>> upstream`.

An upstream rename of a symbol this distribution hooks into surfaces as a merge conflict, a type error, or a failing covering test; the ledger does not track symbols.

## Conflict surface and risk

Forms and metrics cover modified `src/` paths; wholesale replacements such as `CHANGELOG.md` would otherwise dominate the ranking. A path is a `rewrite` when it deletes more than 8 upstream lines or re-indents more than 10 (`MAX_PATCH_DELETIONS`, `MAX_PATCH_REINDENT` in the script), otherwise a `patch`. A path upstream does not have is distribution-owned and has no conflict surface.

| Metric | Definition |
| --- | --- |
| `surface` | Added plus deleted lines against the baseline. |
| `reindent` | `surface` minus the same count with whitespace ignored. |
| `hunks` | Hunks in the baseline diff. |
| `touches` | Non-merge upstream commits changing the path in the window before the baseline commit. |
| `risk` | `surface × touches`. |

`npm run diff:upstream` prints the complete worktree report, including each modified source path's form, surface, re-indentation, and hunks. `--check` validates baseline integrity, upstream dependency pins/ranges across installation scopes, and the rules above. The commit hook uses `--check --staged` to check the index that will be committed, including its baseline manifest, package metadata, ledger, referenced test paths, and conflict markers. An unstaged ledger repair cannot make that gate pass.

`npm run diff:upstream -- --risk [--window <days>]` ranks modified source paths by risk over a 120-day default window. It needs the baseline commit's history and reports `n/a` without it; it never fails and is not part of the hook. Use it to decide where thinning a patch pays off: prefer moving logic into distribution-owned files and leaving one-line hooks in upstream files, and spend that effort on the highest-risk paths. A large patch in a file upstream never touches costs nothing. Recording its totals in a synchronization record is optional.

For an unexpected deviation, inspect the actual diff and introducing commit before describing its impact:

```bash
git diff <sourceTree> -- <path>
git log -p -1 -- <path>
```

An unregistered path can be a prompt wording change; it does not by itself imply an execution or protocol change.

## Keeping deviations small

A deviation earns its maintenance cost only while it does something upstream does not. Retire one as soon as upstream supplies a similar mechanism, even when the result is not identical: prefer upstream's option name, lifecycle, and defaults over an equivalent local variant, and express a policy that must stay as a conversion in front of upstream's mechanism rather than a replacement for it. `compaction/settings.ts` is the reference example — it converts `triggerPercent` into upstream's `reserveTokens` so compaction, its tests, and its SDK signature stay upstream's.

Wholly rewritten documentation pages are the exception. `docs/**` is distribution-owned, and a rewrite that documents real behavior stays even when upstream later edits the same page: keep this distribution's prose and port only upstream's factual changes, which is why `--apply` leaves `docs/` for porting by hand.

## Synchronization runbook

1. Inspect status and existing work. Start a clean synchronization branch from the intended `main` commit; preserve unrelated work. Fetch only the selected release tag and inspect it with `gh`:

   ```bash
   git switch main
   git switch -c sync/upstream-v<version>
   git fetch upstream tag v<version>
   gh release view v<version> --repo earendil-works/pi
   npm run diff:upstream -- --check
   npm run diff:upstream -- --target v<version>
   ```

   If a fresh clone lacks the recorded baseline tree, fetch its exact tag first. Target classification uses the committed HEAD tree; finish or isolate local edits before relying on its collision report.
2. Read the changed source, tests, APIs, documentation, and examples. Classify changes as adopt, adapt, defer, or not applicable. Review each collision with a registered deviation or distribution-owned addition, and decide each path the report leaves for porting by hand. Record this release's decisions under `maintainers/syncs/v<version>.md`; keep durable architecture explanations in [Architecture](architecture.md) and per-concern intent in the ledger.
3. Commit or set aside local edits, then merge the release into the worktree:

   ```bash
   npm run diff:upstream -- --apply v<version>
   ```

   Each upstream change is three-way merged with `git merge-file` against the recorded baseline, and `upstream.json` advances to the release. The review paths (`REVIEW_PATHS` in the script: `README.md`, `CHANGELOG.md`, `docs/`, `package.json`, and `npm-shrinkwrap.json`) are left untouched, because this distribution keeps its own prose there and npm regenerates the manifests. The report lists every other path as `merged`, `added` (already registered with `git add --intent-to-add`), `deleted`, `skipped` (dropped by this distribution), or `conflict`, then lists the review paths with a `git diff` command that shows upstream's change; the command exits nonzero when it leaves conflicts. Resolve conflict markers (`--check` fails while any remain), remove added paths classified as not applicable with `git rm -f`, and decide each binary file the report kept at this distribution's version. Port upstream's factual changes into the review paths by hand. Review dependency **scope** as well as version using [Dependency maintenance](dependencies.md), and regenerate `package.json` and `npm-shrinkwrap.json` through npm. Update distribution documentation and `CHANGELOG.md` under `[Unreleased]`. The root package's release version stays unchanged during synchronization.
4. When adoption is final, reconcile `concerns.json`. `--apply` registers the files it adds; register any upstream path adopted by hand, such as a new documentation page (which also needs a `docs/docs.json` entry), with `git add --intent-to-add -- <paths>` before the worktree comparison. Git otherwise treats an untracked replacement as a deletion plus a separate file.
5. Verify the installed dependency tree, focused behavior tests, and interactive changes as required by AGENTS.md. Use a clean build for deleted sources or changed build/package exclusions. Run `npm run check`, the full diff report, and `npm run diff:upstream -- --check`. For entrypoint, dependency-scope, or packaging changes, pack and run `npm run verify:package-install -- <tarball>`. Include validation results and any explicitly assigned follow-up work in the synchronization record.
6. At an owner-requested checkpoint, inspect status, stage explicit paths, inspect the staged diff, and commit. Follow the lockfile acknowledgement procedure when needed. Existing authorization persists; complete the authorized steps without asking again.
7. If pushing/CI verification is authorized, push the synchronization branch and run the existing CI workflow on that exact commit:

   ```bash
   SYNC_BRANCH="$(git branch --show-current)"
   SYNC_SHA="$(git rev-parse HEAD)"
   gh workflow run ci.yml --repo ming-kang/pi --ref "$SYNC_BRANCH" -f expected_sha="$SYNC_SHA"
   gh run list --repo ming-kang/pi --workflow ci.yml --event workflow_dispatch --commit "$SYNC_SHA" --json databaseId,headSha,status,conclusion,url
   gh run watch <run-id> --repo ming-kang/pi --exit-status
   ```

   The manual trigger must already exist on GitHub's default branch. Ubuntu CI owns POSIX-sensitive complete-suite coverage.
8. When merging is authorized, merge the **standalone synchronization branch** and remove the merged local branch:

   ```bash
   git switch main
   git merge --ff-only sync/upstream-v<version>
   git branch -d sync/upstream-v<version>
   git status --short --branch
   ```

   If `main` diverged, reconcile and revalidate the result before merging; do not force the fast-forward or branch deletion. Delete a published remote synchronization branch only when that cleanup is also in scope. Report the resulting commit, worktree state, and any outstanding validation. Publication/versioning remains governed by the release runbook.

## Synchronization records

- [v0.85.1](syncs/v0.85.1.md)
- [v0.86.0](syncs/v0.86.0.md)
- [v0.86.1](syncs/v0.86.1.md)
- [v0.87.0](syncs/v0.87.0.md)
- [v0.87.1](syncs/v0.87.1.md)
