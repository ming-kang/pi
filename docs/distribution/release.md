# Release checklist

This repository publishes one npm package from its root: `@astralyn/pi`. It does not use the upstream multi-package, binary, source-archive, or model-catalog release flows. Upstream synchronization is documented in [maintenance.md](maintenance.md).

## Scope and versioning

Track the upstream Pi `major.minor` line and reserve the patch number for this distribution's release sequence:

```text
upstream 0.82.x -> Fork 0.82.0, 0.82.1, 0.82.2, ...
upstream 0.83.x -> Fork 0.83.0, 0.83.1, 0.83.2, ...
```

The first distribution release after moving to a new upstream minor uses patch `0`. Every later release on that line uses the next unused patch, including releases that absorb an upstream patch update. Use `pi-v<full-version>` Git tags so they remain distinct from fetched upstream tags such as `v0.82.0`.

## Prepare the release

1. Start from a clean `main` branch and choose the next unused distribution version.
2. Move current `CHANGELOG.md` entries from `[Unreleased]` into one `## [<version>] - YYYY-MM-DD` section, then leave a new empty `[Unreleased]` section.
3. Update `package.json` version.
4. Refresh and review the authoritative shrinkwrap:

```bash
npm install --package-lock-only --ignore-scripts
```

Direct dependencies are exact. If a synchronized upstream release is still blocked by the `.npmrc` age gate, prefer waiting; use `--min-release-age=0` only after explicitly verifying the package versions, provenance, and release contents.

Confirm `package.json` and the root entry in `npm-shrinkwrap.json` carry the same `@astralyn/pi` version and that the intended exact upstream AI, Agent core, and TUI versions are locked.

## Verify

Local development verification:

```bash
npm run build
npm run check
```

Release verification runs on Ubuntu through GitHub Actions. The CI and publish workflows both install from `npm-shrinkwrap.json`, build, check, verify that generated files remain clean, and run the complete test suite.

## Review the package

After building, inspect the root package:

```bash
npm pack --dry-run
```

The tarball must contain the built `dist`, product documentation, examples, README, changelog, and `npm-shrinkwrap.json`. It must not contain source workspaces or local configuration. For stronger verification, create a real tarball, install it in a temporary directory outside the repository, and run `pi --version` and `pi --list-models`.

## Publish and tag

Publishing uses npm Trusted Publishing through GitHub Actions OIDC. Configure the package once on npm:

```text
Publisher: GitHub Actions
Organization or user: ming-kang
Repository: pi
Workflow filename: publish-npm.yml
Environment name: (blank)
Allowed action: Allow npm publish
```

After the release commit is pushed and CI passes, trigger the workflow from an authenticated GitHub CLI session:

```bash
gh workflow run publish-npm.yml --repo ming-kang/pi --ref main -f version=0.82.0

gh run list --repo ming-kang/pi --workflow publish-npm.yml --limit 1
gh run watch <run-id> --repo ming-kang/pi --exit-status
```

The workflow validates the requested version, repeats Ubuntu Build/Check/Test, publishes the repository root with provenance, and verifies the registry version. A normal push to `main` never publishes.

After publication, verify the registry and perform a global-install/self-update smoke test from a separate shell or after restarting Pi. Do not replace the package currently running the release session.

Finally tag the exact release commit:

```bash
git tag pi-v<full-version>
git push origin pi-v<full-version>
```

No other package is published from this repository.
