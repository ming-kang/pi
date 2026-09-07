# Release

This runbook owns distribution versioning, publication, and tags. Complete [synchronization](upstream.md) first; follow [AGENTS.md](../AGENTS.md) for authorization and repository safety and [Dependency maintenance](dependencies.md) for lockfile review and age exceptions.

## Prepare the release commit

Follow upstream's `major.minor` line; this distribution owns its patch sequence. Start at patch `0` on a new minor, then choose the next unused patch. Check npm versions and existing `pi-v*` tags before choosing it.

Move prepared changelog entries from `[Unreleased]` to one `## [<version>] - YYYY-MM-DD` heading, leaving a new empty `[Unreleased]`. Update the root package version and regenerate the shrinkwrap. Stage explicit files and create the owner-requested release commit.

Verify a clean build, installed dependencies, repository checks, upstream ledger, and a packed installation. The release workflow repeats these checks, runs the complete Ubuntu suite, publishes that exact verified tarball, and verifies its registry installation. Resolve required manual validation before publication.

## Pin the publication to a commit

Record the release SHA after creating the release commit. Push that commit to `main` when publication is authorized, then select its CI run explicitly:

```bash
VERSION="$(node -p "require('./package.json').version")"
RELEASE_SHA="$(git rev-parse HEAD)"
gh run list --repo ming-kang/pi --workflow ci.yml --branch main --commit "$RELEASE_SHA" --json databaseId,headSha,status,conclusion,url
gh run watch <ci-run-id> --repo ming-kang/pi --exit-status
```

Dispatch publication only after CI for this SHA succeeds:

```bash
gh workflow run publish-npm.yml --repo ming-kang/pi --ref main -f version="$VERSION" -f expected_sha="$RELEASE_SHA"
gh run list --repo ming-kang/pi --workflow publish-npm.yml --event workflow_dispatch --commit "$RELEASE_SHA" --json databaseId,headSha,displayTitle,createdAt,status,conclusion,url
gh run watch <publish-run-id> --repo ming-kang/pi --exit-status
gh run view <publish-run-id> --repo ming-kang/pi --json headSha,conclusion,url
```

Select the run ID for this dispatch and confirm `headSha` equals the recorded SHA. The workflow rejects a moved `main`, a version mismatch, or a conflicting existing npm provenance record. Do not identify publication by an unfiltered "latest run". When resuming a failed publication, use the same version and SHA and inspect that run's failed step first.

## Verify and tag the published commit

Confirm the registry installation check passed. Perform global-install/self-update checks from a separate shell or after restarting Pi; do not replace the package running the release session.

Tag the recorded published SHA explicitly, even if local HEAD has moved:

```bash
git tag "pi-v$VERSION" "$RELEASE_SHA"
git push origin "refs/tags/pi-v$VERSION"
```

If the tag already exists, verify its target equals `RELEASE_SHA`; never move an existing release tag. Report the package version, published SHA, workflow run URL, and tag.
