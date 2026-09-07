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

The repository's `.npmrc` sets `min-release-age=2` (days). Keep that default for ordinary resolution. An explicitly requested, identified release may be adopted before that age; record the target tag/version and the reviewed lockfile changes in the synchronization record. Existing owner authorization for that version remains sufficient; do not ask for it again.

The controls have separate purposes:

| Control | Scope and meaning |
| --- | --- |
| `--min-release-age=0` | An exception for one npm resolution/install command. It applies to that command's dependency resolution, so inspect all resulting changes. |
| `PI_PACKAGE_ALLOW_FRESH=1` | Allows fresh packages in the verifier's child npm installation. Used for a reviewed fresh upstream release or verification immediately after publishing this package. |
| `PI_ALLOW_LOCKFILE_CHANGE=1` | Acknowledges review of the staged lockfile for one commit. It does not change npm resolution or replace the other checks. |

For an authorized fresh release, append `--min-release-age=0` to the two install commands above. Do not change global npm configuration.

Bash examples after review:

```bash
PI_PACKAGE_ALLOW_FRESH=1 npm run verify:package-install -- /path/to/package.tgz
PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "feat: sync upstream v<version>"
```

PowerShell 7 equivalents, with flags scoped to the operation:

```powershell
$env:PI_PACKAGE_ALLOW_FRESH = "1"
try { npm run verify:package-install -- C:/path/to/package.tgz }
finally { Remove-Item Env:PI_PACKAGE_ALLOW_FRESH }

$env:PI_ALLOW_LOCKFILE_CHANGE = "1"
try { git commit -m "feat: sync upstream v<version>" }
finally { Remove-Item Env:PI_ALLOW_LOCKFILE_CHANGE }
```

The commit guard prints a bounded summary even when its acknowledgement flag is set.

## Recover an inconsistent installation

If npm reports "up to date" but the installed-package check finds old files, first compare the declaration, shrinkwrap entry, and reported package file. A stale `node_modules/.package-lock.json` can mislead npm. Once confirmed, remove only that cache file and reinstall:

```powershell
Remove-Item -LiteralPath ./node_modules/.package-lock.json
npm install --ignore-scripts
npm run check:installed-deps
```

Use the same reviewed age exception if still necessary. A deliberate `npm ci --ignore-scripts` is the fallback for reconstructing the full managed installation. Resume builds and tests only after the installed-package check passes.
