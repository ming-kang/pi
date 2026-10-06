# Release

This runbook owns distribution versioning, publication, and tags. Complete [synchronization](upstream.md) first; follow [AGENTS.md](../AGENTS.md) for authorization and repository safety and [Dependency maintenance](dependencies.md) for lockfile review and age exceptions.

## Prepare the release commit

Follow upstream's `major.minor` line; this distribution owns its patch sequence. Start at patch `0` on a new minor, then choose the next unused patch. Check npm versions and existing `pi-v*` tags before choosing it.

Move prepared changelog entries from `[Unreleased]` to one `## [<version>] - YYYY-MM-DD` heading, leaving a new empty `[Unreleased]`. Update the root package version and regenerate the shrinkwrap. Stage explicit files and create the owner-requested release commit.

Verify a clean build, repository checks, and a packed installation locally, and resolve required manual validation before publication. `verify:package-install` installs a tarball through a loopback registry, so it sees the same nested, shrinkwrap-locked layout that users get from npm.

## Publish by tag

When publication is authorized, push the release commit to `main`, then tag that commit:

```bash
VERSION="$(node -p "require('./package.json').version")"
git push origin main
git tag "pi-v$VERSION" HEAD
git push origin "refs/tags/pi-v$VERSION"
gh run list --repo ming-kang/pi --workflow publish-npm.yml --event push --branch "pi-v$VERSION" --json databaseId,headSha,status,conclusion,url
gh run watch <run-id> --repo ming-kang/pi --exit-status
```

The tag push runs `publish-npm.yml`. It rejects a tag that does not match `package.json`, the shrinkwrap, and one `CHANGELOG.md` heading, or whose commit is not on `main`. It then runs the full CI job on the tagged commit (build, checks, upstream ledger, complete Ubuntu suite, packed installation) and publishes that exact verified tarball with provenance. Rerunning the workflow for a version already on npm skips publication.

## Recover a failed release

If the run fails before publication, the version was never published: fix the problem in a new commit, delete the tag (`git push origin --delete "refs/tags/pi-v$VERSION"` and `git tag -d "pi-v$VERSION"`), and tag the new commit. Never move or delete the tag of a version that npm has published; publish a new patch instead.

Perform global-install/self-update checks from a separate shell or after restarting Pi; do not replace the package running the release session. Report the package version, tagged SHA, and workflow run URL.
