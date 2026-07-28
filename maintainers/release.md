# Release

This repository publishes only the root `@astralyn/pi` package. Complete any upstream release-tag synchronization first; this guide covers distribution versioning, package review, publication, and tagging.

## Versioning and changelog

Distribution releases follow the upstream Pi `major.minor` line while this repository owns the patch sequence:

```text
upstream <major>.<minor>.x
    -> @astralyn/pi <major>.<minor>.0, <major>.<minor>.1, <major>.<minor>.2, ...
```

Use patch `0` for the first distribution release on a new upstream minor and the next unused patch for every later release on that line, including one that adopts an upstream patch update. Tag the exact release commit as `pi-v<full-version>` so it cannot collide with upstream `v<version>` tags.

`CHANGELOG.md` covers `@astralyn/pi` from `0.81.1-1` onward and records both adopted upstream behavior and distribution-local changes. Move prepared entries from `[Unreleased]` into `## [<version>] - YYYY-MM-DD`, then leave a new empty `[Unreleased]` section.

## Prepare and verify

1. Start from the intended release commit and choose the next unused version.
2. Update the changelog and root `package.json` version.
3. Regenerate and review the published shrinkwrap:

   ```bash
   npm install --package-lock-only --ignore-scripts
   ```

4. Confirm that `package.json` and the shrinkwrap root carry the same distribution version and that all direct dependencies remain exact.
5. Run local release verification:

   ```bash
   npm run build
   npm run check
   npm run diff:upstream -- --check
   npm pack --dry-run
   ```

The upstream-delta command is required boundary verification for local release checks and a hard gate in both CI and publication. Ordinary `npm run check` remains offline; baseline network access is isolated to the dedicated workflow fetch step. That step reads `baseline.repository` and `baseline.tag` from `maintainers/upstream.json` and fetches that exact recorded public upstream tag; local verification uses the recorded canonical tree/tag available in the local clone.

Inspect the dry-run tarball. It must contain built `dist`, distribution-owned documentation and examples, README, changelog, and `npm-shrinkwrap.json`; it must not contain `maintainers/**`, source workspaces, or local configuration. For a stronger smoke test, install a real tarball outside the repository and run `pi --version` and `pi --list-models`.

## Publish and tag

Publishing uses npm Trusted Publishing through the manually dispatched GitHub Actions OIDC workflow. After the release commit is pushed and its configured CI passes, trigger publication from an authenticated GitHub CLI session:

```bash
VERSION="$(node -p "require('./package.json').version")"
gh workflow run publish-npm.yml --repo ming-kang/pi --ref main -f version="$VERSION"
gh run list --repo ming-kang/pi --workflow publish-npm.yml --limit 1
gh run watch <run-id> --repo ming-kang/pi --exit-status
```

Verify the published registry version and perform a global-install/self-update smoke test from a separate shell or after restarting Pi. Do not replace the package running the release session.

Finally tag and push the exact published commit:

```bash
git tag pi-v<full-version>
git push origin pi-v<full-version>
```
