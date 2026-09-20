# Upstream synchronization

Follow [AGENTS.md](../AGENTS.md) and the ownership rules in [Architecture](architecture.md). Synchronization adopts an exact upstream release; [publication](release.md) is a separate operation.

## Baseline and deviation ledger

`upstream.json` records the repository, exact release tag/commit, source subtree, and root-mapped source tree. Compare against that tree, never a branch tip. `deltas.json` records each modified or dropped upstream path with its reason and covering tests; directory entries end in `/`.

| Category | Treatment during synchronization |
| --- | --- |
| `distribution` | Preserve standalone packaging, identity, and distribution-owned documentation. |
| `bugfix` | Retire when upstream supplies the equivalent fix. |
| `windows-compat` | Verify with a native Windows reproduction before retiring. |
| `ui` | Merge upstream behavior into the distribution's presentation. |
| `extension-support` | Merge public API evolution; retire additions once no consumer needs them or upstream supplies an equivalent. |

`npm run diff:upstream` prints the complete worktree report. `--check` validates baseline integrity, upstream dependency pins/ranges across installation scopes, and ledger coverage. The commit hook uses `--check --staged` to check the index that will be committed, including its baseline manifest, package metadata, ledger, and referenced test paths. An unstaged ledger repair cannot make that gate pass.

For an unexpected deviation, inspect the actual diff and introducing commit before describing its impact:

```bash
git diff <sourceTree> -- <path>
git log -p -1 -- <path>
```

An unregistered path can be a prompt wording change; it does not by itself imply an execution or protocol change.

## Keeping deviations small

A deviation earns its maintenance cost only while it does something upstream does not. Retire one as soon as upstream supplies a similar mechanism, even when the result is not identical: prefer upstream's option name, lifecycle, and defaults over an equivalent local variant, and express a policy that must stay as a conversion in front of upstream's mechanism rather than a replacement for it. `compaction/settings.ts` is the reference example — it converts `triggerPercent` into upstream's `reserveTokens` so compaction, its tests, and its SDK signature stay upstream's.

Wholly rewritten documentation pages are the exception. `docs/**` is distribution-owned, and a rewrite that documents real behavior stays even when upstream later edits the same page: resolve such a conflict by keeping this distribution's prose and porting only upstream's factual changes.

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
2. Read the changed source, tests, APIs, documentation, and examples. Classify changes as adopt, adapt, defer, or not applicable. Review each collision with a registered deviation or distribution-owned addition. Record this release's decisions under `maintainers/syncs/v<version>.md`; keep durable architecture explanations in [Architecture](architecture.md) and per-path intent in the ledger.
3. Apply compatible changes. Review dependency **scope** as well as version using [Dependency maintenance](dependencies.md). Update distribution documentation and `CHANGELOG.md` under `[Unreleased]`. The root package's release version stays unchanged during synchronization.
4. When adoption is final, update all fields of `upstream.json` and reconcile `deltas.json`. Explicitly register newly adopted upstream paths with `git add --intent-to-add -- <paths>` before the worktree comparison; Git otherwise treats an untracked replacement as a deletion plus a separate file.
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
