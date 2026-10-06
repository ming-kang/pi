# Release

This runbook owns distribution versioning, publication, and tags. Adopt upstream releases first via [Upstream synchronization](upstream.md).

## Versions

The distribution follows upstream's `major.minor` line and owns the patch: a release on a newer upstream line starts at patch `0`, and every other release increments the patch. `npm run release` computes this; pass an explicit version only to break the rule deliberately.

## Publish

From an up-to-date `main` with entries under `## [Unreleased]` in `CHANGELOG.md`:

```bash
npm run release -- --dry-run   # preview the version and changelog section
npm run release
```

The command refuses a version already on npm or tagged, then moves the `[Unreleased]` entries under `## [<version>] - <date>`, bumps `package.json` and the shrinkwrap, commits `chore: release <version>` through the normal commit hook, creates the `pi-v<version>` tag, and, after a confirmation (`--yes` skips it), pushes `main` and the tag together.

The tag runs `publish-npm.yml`. It rejects a tag that does not match `package.json`, the shrinkwrap, and one `CHANGELOG.md` heading, or whose commit is not on `main`. It then runs the full CI on the tagged commit (build, checks, upstream ledger, complete Ubuntu suite, and an install of the packed tarball through a loopback registry, which reproduces the nested, shrinkwrap-locked layout users get) and publishes that exact tarball with provenance. Rerunning it for a version already on npm skips publication. Watch it with the `gh` commands the release prints.

## Recover a failed release

If the run fails before publication, the version was never published. Fix the problem in a new commit on `main`, push it, and move the tag:

```bash
npm run release -- --retag
```

It refuses when the version is already on npm. Never move or delete the tag of a published version; release a new patch instead.

Perform global-install or self-update checks from a separate shell or after restarting Pi; do not replace the package running the release session.
