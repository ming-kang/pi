# Release

This runbook owns distribution versioning, publication, and release tags.

## Versioning scheme

The distribution follows upstream's `major.minor` line and increments the patch:
- Synchronizing to a new upstream `major.minor` resets the patch to `0` (e.g. `1.4.0`).
- Distribution-specific fixes and features increment the patch (e.g. `1.4.1`, `1.4.2`).
- `npm run release` computes the target version automatically.

## Release flow

1. **Preview without changing anything:**
   ```bash
   npm run release -- --dry-run
   ```
   This validates the repository, target version, changelog, tags, and npm state, then prints the proposed release. It never asks for confirmation or writes files.

2. **Confirm and release:**
   ```bash
   npm run release
   ```
   Non-interactive automation must explicitly opt in:
   ```bash
   npm run release -- --yes
   ```
   After confirmation, the command:
   - Moves `[Unreleased]` changelog entries to a new version header.
   - Bumps `package.json` and updates `package-lock.json`.
   - Commits `chore: release <version>` and creates annotated tag `pi-v<version>`.
   - Pushes `main` and the tag with one atomic push.

   Declining confirmation, or running non-interactively without `--yes`, leaves the repository unchanged. The pre-commit hook still runs the repository checks before the release commit can be created.

3. **Verify and publish in CI:**
   The tag triggers `publish-npm.yml`. It verifies the tag and version, runs full Ubuntu CI, tests installation from the packed tarball, and publishes that verified artifact to npm with provenance. The release command prints the `gh` commands for watching the run.

A pushed tag is immutable, including when its workflow fails before publication.

## Failure recovery

- **Atomic push failed:** The release commit and tag remain local. Fix the network, authentication, or remote-state problem, then run the exact `git push --atomic ...` command printed by the script. Do not run `npm run release` again for the same release.
- **CI failed before npm publication:** For a transient infrastructure failure, rerun the failed workflow for the same tag. If the code or tests must change, land the fix with a new `[Unreleased]` entry and release the next patch instead.
- **npm publication succeeded:** Never move or delete its tag. Publish any further code change as a new patch.
