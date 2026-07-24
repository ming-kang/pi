# Release checklist

This Fork publishes one npm package, `@astralyn/pi`. It does not use the upstream multi-package release flow. Routine upstream synchronization and conflict handling are documented separately in the [Fork maintenance guide](maintenance.md).

## Scope and versioning

Track the upstream Pi `major.minor` line and reserve the patch number for this distribution's release sequence:

```text
upstream 0.82.x -> Fork 0.82.0, 0.82.1, 0.82.2, ...
upstream 0.83.x -> Fork 0.83.0, 0.83.1, 0.83.2, ...
```

The first Fork release after moving to a new upstream minor uses patch `0`. Every later release on that line uses the next unused Fork patch, including releases that absorb an upstream patch update. Reset to patch `0` only when the tracked upstream minor changes.

Use `pi-v<full-version>` for Fork tags, for example `pi-v0.82.0`. The product prefix keeps them distinct from fetched upstream tags such as `v0.82.0`.

## Prepare the release

1. Start from a clean `main` branch. Fetch `upstream`, confirm the tracked upstream minor, and choose the next unused Fork patch on that line.
2. Move the current `packages/coding-agent/CHANGELOG.md` entries from `[Unreleased]` into one `## [<version>] - YYYY-MM-DD` section, then leave a new empty `[Unreleased]` section. Fold newly inherited upstream notes into that same Fork release section; if synchronization introduced a matching upstream heading, merge the headings instead of keeping duplicates.
3. Update both version references:
   - `packages/coding-agent/package.json` — `version`
   - `packages/server/package.json` — exact `dependencies["@astralyn/pi"]`
4. Refresh generated package metadata from the repository root:

```bash
npm install --package-lock-only --ignore-scripts
npm run shrinkwrap:coding-agent
npm run install-lock:coding-agent
```

`npm run check:fork-versions` rejects a stale server dependency. The install-lock generator separately verifies that its bundled `@astralyn/pi` entry matches the installer version.

Each Fork release has a unique stable `X.Y.Z` version, so startup changelog detection and `/changelog` use the same version recorded in the package metadata.

## Verify

Windows is not the release test environment for this Fork. The full test suite depends on Linux path, symlink, and filesystem behavior, so release verification runs in GitHub Actions on `ubuntu-latest`.

The `CI` workflow runs automatically after pushing `main` and must pass Build, Check, and Test. The publish workflow repeats those checks before uploading the package, so local full-suite execution is not required.

Interactive behavior is maintained through the normal development process and prior extension verification; it is not a release blocker for the already-verified built-in extensions.

## Review the package

From `packages/coding-agent`, inspect the package contents after the build:

```bash
npm pack --dry-run
```

`npm pack` does not run this package's `prepublishOnly` script, so do not use an unbuilt checkout for package review. `npm publish` does run `prepublishOnly`, which cleans, rebuilds, and regenerates the shrinkwrap.

For stronger pre-publish verification, create a real tarball and install it from a temporary directory outside the repository, then run `pi --version` and `pi --list-models`.

## Publish and tag

Publishing uses npm Trusted Publishing through GitHub Actions OIDC. Configure the package once on npm under its Trusted Publisher settings:

```text
Publisher: GitHub Actions
Organization or user: ming-kang
Repository: pi
Workflow filename: publish-npm.yml
Environment name: (blank)
Allowed action: Allow npm publish
```

Do not enable `npm stage publish`; this Fork publishes directly to the public `latest` tag.

After the release commit is pushed and the `CI` workflow passes, trigger the publish workflow from a local authenticated GitHub CLI session:

```bash
gh workflow run publish-npm.yml --repo ming-kang/pi --ref main -f version=0.82.0

gh run list \
  --repo ming-kang/pi \
  --workflow publish-npm.yml \
  --limit 1

gh run watch <run-id> --repo ming-kang/pi --exit-status
```

The workflow validates the requested version, runs Ubuntu Build/Check/Test, publishes only `@astralyn/pi` with provenance, and verifies that npm exposes the version. A push to `main` does **not** publish automatically.

After the workflow succeeds, verify the registry and perform the global-install/self-update smoke test from a separate shell or after restarting Pi. Do not replace the package that is currently running the release session.

Finally, tag the exact release commit:

```bash
git tag pi-v<full-version>
git push origin pi-v<full-version>
```

Do not publish other workspace packages or restore the upstream multi-package release workflow.
