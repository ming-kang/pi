# Release

This runbook owns distribution versioning, publication, and release tags.

## Versioning scheme

The distribution follows upstream's `major.minor` line and increments the patch:
- Synchronizing to a new upstream `major.minor` resets the patch to `0` (e.g. `1.4.0`).
- Distribution-specific fixes and features increment the patch (e.g. `1.4.1`, `1.4.2`).
- `npm run release` computes the target version automatically.

## CI on `main`

Every push to `main` runs `publish-npm.yml`: full CI builds the tarball and checks that it installs. Each commit's run completes on its own, so a later push never cancels it. Only a release commit publishes, meaning the `chore: release <version>` commit made by `npm run release` for a version npm does not have yet. Every other run stops after CI. A release run succeeds only after npm serves the exact version as `latest` and the release tag exists.

## Release flow

Release only what `main` already has and CI has passed:

1. **Push and wait:** Push `main` and wait for its run to pass. `npm run release` needs an authenticated GitHub CLI (`gh auth status`) to check that run.
2. **Preview:** `npm run release -- --dry-run` checks the repository, CI, version, changelog, and npm, then prints the release without changing anything.
3. **Release:** `npm run release` refuses unless `HEAD` is `origin/main` and its CI passed. After confirmation, it:
   - moves the `[Unreleased]` changelog entries under a new version heading;
   - bumps `package.json` and `package-lock.json`;
   - commits `chore: release <version>`;
   - pushes `main`.

   Automation passes `--yes` instead of confirming. Declining leaves the repository unchanged.
4. **Publish:** The release commit's run publishes the tarball its CI verified, with provenance. npm accepting the tarball does not mean it is immediately visible: the tag job then runs the same logic as `npm run release:wait` until npm serves both the exact version and its `latest` dist-tag, with a 30-minute timeout. Only then does it tag that commit `pi-v<version>`. Watch it in the workflow's Actions page; the release command prints the link. To check manually, run `npm run release:wait -- [version]` (the checkout's version when omitted).

The release commit changes only the version and changelog, so its CI repeats a pass on the same code. The package, the `pi-v<version>` tag, and the changelog section therefore always describe the same commit. Never create, move, or delete a `pi-v` tag by hand.

## Failure recovery

- **Push failed:** The release commit stays local. Fix the problem, then run `git push origin main`. Do not run `npm run release` again.
- **CI failed before publication:** Nothing was published or tagged, and later pushes do not publish the version either. For a transient infrastructure failure, rerun the failed run. Otherwise, fix `main` as usual, with changelog entries under `[Unreleased]`, then push, wait for CI, and run `npm run release` again. Because `package.json` names a version npm lacks, it releases that same version once more. It folds the new `[Unreleased]` entries into that version's section and makes a new release commit, which may be empty.
- **The npm wait or tagging failed after publication:** npm may already have accepted the package even though it is not visible yet. Rerun only the failed tag job; it waits again and does not repeat `npm publish`. Do not run `npm run release` or `npm publish` again while the original publication may still be processing. A timeout does not prove that the package failed to go live.
