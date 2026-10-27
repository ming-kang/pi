# Release

This runbook owns distribution versioning, publication, and release tags.

## Versioning scheme

The distribution follows upstream's `major.minor` line and increments the patch:
- Synchronizing to a new upstream `major.minor` resets the patch to `0` (e.g. `1.4.0`).
- Distribution-specific fixes and features increment the patch (e.g. `1.4.1`, `1.4.2`).
- `npm run release` computes the target version automatically.

## Pre-flight checklist

Before releasing:
1. Working tree is clean on `main` and up to date.
2. `CHANGELOG.md` has entries under `## [Unreleased]`.
3. All checks and ledger validations pass (`npm run check && npm run diff:upstream -- --check`).

## Publication workflow

1. **Preview:**
   ```bash
   npm run release -- --dry-run
   ```
2. **Release:**
   ```bash
   npm run release
   ```
   This command:
   - Verifies the version is not already tagged or published.
   - Moves `[Unreleased]` changelog entries to a new version header.
   - Bumps `package.json` and updates `npm-shrinkwrap.json`.
   - Commits `chore: release <version>`.
   - Tags `pi-v<version>`.
   - Pushes `main` and the tag to GitHub.

3. **CI Publication:**
   The tag triggers `publish-npm.yml`, which runs full Ubuntu CI, tests loopback installation from the packed tarball, and publishes to npm with provenance.

## Recovering a failed release

If CI fails before npm publication:
1. Fix the failure on `main` and push the commit.
2. Move the release tag:
   ```bash
   npm run release -- --retag
   ```

*Note: If the package was already published to npm, never move or delete the tag. Release a new patch instead.*
