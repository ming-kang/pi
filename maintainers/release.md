# Release

This runbook owns distribution versioning, publication, and release tags.

## Versioning scheme

The distribution follows upstream's `major.minor` line and increments the patch:
- Synchronizing to a new upstream `major.minor` resets the patch to `0` (e.g. `1.4.0`).
- Distribution-specific fixes and features increment the patch (e.g. `1.4.1`, `1.4.2`).
- `npm run release` computes the target version automatically.

## Release flow

1. **Preview:** `npm run release -- --dry-run` checks the repository, version, changelog, and npm, then prints the release without changing anything.
2. **Release:** `npm run release` asks for confirmation, then:
   - moves the `[Unreleased]` changelog entries under a new version heading;
   - bumps `package.json` and `package-lock.json`;
   - commits `chore: release <version>`;
   - pushes `main`.

   Automation passes `--yes` instead of confirming. Declining leaves the repository unchanged.
3. **Publish:** Every push to `main` runs `publish-npm.yml`. It runs full CI and builds the tarball, then checks that the tarball installs. If CI passes and npm doesn't have the version yet, it publishes that tarball with provenance and tags the commit `pi-v<version>`. Watch the run in the workflow's Actions page; the release command prints the link.

CI publishes and tags only a commit it has tested. A `pi-v<version>` tag therefore always marks a published version, so never create, move, or delete one by hand.

## Failure recovery

- **Push failed:** The release commit stays local. Fix the problem, then run `git push origin main`. Do not run `npm run release` again.
- **CI failed:** Nothing was published or tagged. Fix `main` and push; the next passing run publishes the same version. Put any user-visible fix in that version's changelog section, not `[Unreleased]`. For a transient infrastructure failure, rerun the failed run instead.
- **Tagging failed after publication:** Rerun the failed jobs of that run; only the tag job runs again.
