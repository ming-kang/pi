# Release checklist

This Fork publishes one npm package, `@astralyn/pi`. It does not use the upstream multi-package release flow.

## Scope and versioning

Base each release on an upstream Pi version and append a numeric prerelease revision:

```text
upstream 0.81.1 -> 0.81.1-1, 0.81.1-2, ...
upstream 0.82.0 -> 0.82.0-1
```

Use `v<full-version>` for the Fork tag, for example `v0.81.1-1`. Fork tags therefore do not collide with upstream tags such as `v0.81.1`.

## Prepare the release

1. Start from a clean `main` branch. Fetch `upstream` and confirm which upstream version the release tracks.
2. Move the current `packages/coding-agent/CHANGELOG.md` entries from `[Unreleased]` into `## [<version>] - YYYY-MM-DD`, then leave a new empty `[Unreleased]` section.
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

Pi's current changelog parser compares only the upstream `X.Y.Z` portion. It does not distinguish multiple `-N` Fork revisions based on the same upstream version when deciding which startup changelog entries are new; `/changelog` still shows the recorded history.

## Verify

Windows is not the release test environment for this Fork. The full test suite depends on Linux path, symlink, and filesystem behavior, so release verification runs in GitHub Actions on `ubuntu-latest`.

The `CI` workflow runs automatically after pushing `main` and must pass Build, Check, and Test. The publish workflow repeats those checks before uploading the package, so local full-suite execution is not required.

Local package review remains optional and non-authoritative:

```bash
cd packages/coding-agent
npm pack --dry-run
```

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
gh workflow run publish-npm.yml \
  --repo ming-kang/pi \
  --ref main \
  -f version=0.81.1-2

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
git tag v<full-version>
git push origin v<full-version>
```

Do not publish other workspace packages or restore the upstream multi-package release workflow.
