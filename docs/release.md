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

Run the release checks explicitly:

```bash
npm run check
npm run build:offline
./test.sh
```

Run any focused tests relevant to the release and exercise affected interactive behavior in a real TTY. Lifecycle extensions should also be checked through `/reload` and `/tree` where applicable.

## Review the package

From `packages/coding-agent`, inspect the package contents after the build:

```bash
npm pack --dry-run
```

`npm pack` does not run this package's `prepublishOnly` script, so do not use an unbuilt checkout for package review. `npm publish` does run `prepublishOnly`, which cleans, rebuilds, and regenerates the shrinkwrap.

For stronger pre-publish verification, create a real tarball and install it from a temporary directory outside the repository, then run `pi --version` and `pi --list-models`.

## Publish and tag

1. Commit the verified release files with explicit path staging, push `main`, and wait for CI.
2. Confirm npm access with `npm whoami`.
3. From `packages/coding-agent`, publish the public package:

```bash
npm publish --access public
```

4. Verify the registry and an installation outside the repository:

```bash
npm view @astralyn/pi version
npm install -g @astralyn/pi
pi --version
pi --list-models
```

The repository `.npmrc` sets `min-release-age=2`; running the installation smoke test outside the repository avoids that local age gate immediately after publishing.

5. After the publish succeeds, tag the release commit and push the tag:

```bash
git tag v<full-version>
git push origin v<full-version>
```

Do not publish other workspace packages or restore the upstream release/publish workflow for this process.
