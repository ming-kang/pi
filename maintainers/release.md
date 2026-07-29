# Release

This repository publishes only the root `@astralyn/pi` package. Complete [upstream synchronization](upstream.md) first. Publication and tagging are irreversible; use this runbook only for the intended release commit.

## Version and changelog

Follow the upstream Pi `major.minor` line while this distribution owns the patch sequence: use patch `0` for its first release on a new upstream minor, then the next unused patch for later releases. Tag the published commit as `pi-v<full-version>`.

Move prepared `CHANGELOG.md` entries from `[Unreleased]` into `## [<version>] - YYYY-MM-DD`, then leave a new empty `[Unreleased]` section. Update the root `package.json` version and regenerate the shrinkwrap:

```bash
npm install --package-lock-only --ignore-scripts
```

Confirm the package and shrinkwrap root versions match and direct dependencies remain exact.

## Review and verify

Run:

```bash
npm run build
npm run check
npm run diff:upstream -- --check
npm pack --dry-run
```

Inspect the dry-run tarball: it must contain built `dist`, shipped documentation and examples, README, changelog, and `npm-shrinkwrap.json`, but not `maintainers/**`, source workspaces, or local configuration. For a stronger smoke test, install a real tarball outside the repository and run `pi --version` and `pi --list-models`.

## Publish and tag

After the release commit is pushed and configured CI passes, use the manually dispatched npm Trusted Publishing workflow from an authenticated GitHub CLI session:

```bash
VERSION="$(node -p "require('./package.json').version")"
gh workflow run publish-npm.yml --repo ming-kang/pi --ref main -f version="$VERSION"
gh run list --repo ming-kang/pi --workflow publish-npm.yml --limit 1
gh run watch <run-id> --repo ming-kang/pi --exit-status
```

Verify the registry version and perform a global-install/self-update smoke test from a separate shell or after restarting Pi. Do not replace the package running the release session. Finally tag and push the exact published commit:

```bash
git tag pi-v<full-version>
git push origin pi-v<full-version>
```
