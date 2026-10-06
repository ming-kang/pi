# Dependency maintenance

Dependency ownership is defined in [Architecture](architecture.md#dependency-boundary). `package.json` declares installation scope and exact versions; `npm-shrinkwrap.json` records resolution. This page owns installation, verification, and exception handling.

## Install and verify

Use the Node version supported by the package and npm 11.15.0, matching CI. For a clean checkout:

```bash
npm ci --ignore-scripts
npm run check:installed-deps
```

For a local maintainer checkout, run `npm run prepare` once to register the repository's Husky hook. The deliberate `--ignore-scripts` installation does not run that setup automatically.

`check:installed-deps` compares root declarations, shrinkwrap specs/resolutions, and the package metadata actually found through Node's search paths. It reads package files, not npm's hidden installation cache. Missing optional packages are allowed. It runs before `npm test`, `npm run build`, and `npm run check`; direct `npx vitest` invocations bypass that npm pretest hook.

For an intentional dependency update, edit exact versions and installation scopes, then:

```bash
npm install --package-lock-only --ignore-scripts
npm install --ignore-scripts
npm run check:pinned-deps
npm run check:installed-deps
git diff -- package.json npm-shrinkwrap.json
```

Review every changed package, dependency scope, resolution, integrity change, and relevant lifecycle script. Run focused tests and a clean build when imports, exports, or build exclusions change. Verify an actual packed installation with development dependencies omitted before handing off a package-boundary change.

## Release age and explicit exceptions

The repository's `.npmrc` sets `min-release-age=2` (days). Keep that default for ordinary resolution. `npm run sync` installs the selected upstream release with `--min-release-age=0` for that one command, because the owner chose that exact release; inspect every resulting lockfile change.

The commit hook accepts a staged `npm-shrinkwrap.json` without acknowledgement when the only changes are the root version and `@earendil-works/*` packages moving to the version in `maintainers/upstream.json`, as in a release commit or a plain synchronization. Any other change (a new or updated third-party package, even one pulled in by an upstream package) prints a bounded summary and needs a reviewed acknowledgement for that commit:

| Control | Scope and meaning |
| --- | --- |
| `--min-release-age=0` | An exception for one npm resolution/install command. It applies to that command's dependency resolution, so inspect all resulting changes. |
| `PI_PACKAGE_ALLOW_FRESH=1` | Allows fresh packages in the verifier's child npm installation, for a reviewed fresh upstream release. |
| `PI_ALLOW_LOCKFILE_CHANGE=1` | Acknowledges review of the staged lockfile for one commit. It does not change npm resolution or replace the other checks. |

Do not change global npm configuration. Scope each flag to its operation; in PowerShell 7:

```powershell
$env:PI_ALLOW_LOCKFILE_CHANGE = "1"
try { git commit -m "feat: sync upstream v<version>" }
finally { Remove-Item Env:PI_ALLOW_LOCKFILE_CHANGE }
```

## Recover an inconsistent installation

If npm reports "up to date" but the installed-package check finds old files, first compare the declaration, shrinkwrap entry, and reported package file. A stale `node_modules/.package-lock.json` can mislead npm. Once confirmed, remove only that cache file and reinstall:

```powershell
Remove-Item -LiteralPath ./node_modules/.package-lock.json
npm install --ignore-scripts
npm run check:installed-deps
```

Use the same reviewed age exception if still necessary. A deliberate `npm ci --ignore-scripts` is the fallback for reconstructing the full managed installation. Resume builds and tests only after the installed-package check passes.
