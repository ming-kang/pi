# Dependency maintenance

Dependency boundaries are defined in [Architecture](architecture.md#dependency-boundary). `package.json` declares exact pinned dependencies; `npm-shrinkwrap.json` records resolved artifacts.

## Workflows

### 1. Clean checkout installation

Match CI using supported Node and npm 11.15.0:

```bash
npm ci --ignore-scripts
npm run check:installed-deps
npm run prepare   # run once locally to set up git hooks
```

`check:installed-deps` verifies that packages on disk match declarations and shrinkwrap resolutions. It runs automatically before `npm test`, `npm run build`, and `npm run check`.

### 2. Updating dependencies

To add or update an exact dependency:

1. Update `package.json` with the exact version (no `^` or `~`).
2. Refresh the lockfile and install:
   ```bash
   npm install --package-lock-only --ignore-scripts
   npm install --ignore-scripts
   ```
3. Verify pins and consistency:
   ```bash
   npm run check:pinned-deps
   npm run check:installed-deps
   git diff -- package.json npm-shrinkwrap.json
   ```
4. For packaging boundary changes, verify with `npm run verify:package-install`.

### 3. Recovering from an inconsistent installation

If npm claims packages are up to date but `check:installed-deps` reports discrepancies, stale installation cache may be interfering. Clear the internal metadata and reinstall:

```bash
# On Bash:
rm -f ./node_modules/.package-lock.json
npm install --ignore-scripts
npm run check:installed-deps
```

```powershell
# On PowerShell:
Remove-Item -LiteralPath ./node_modules/.package-lock.json -ErrorAction SilentlyContinue
npm install --ignore-scripts
npm run check:installed-deps
```

If issues persist, perform a clean reset with `npm ci --ignore-scripts`.

## Lockfile controls and release age

The repository sets `min-release-age=2` days in `.npmrc` to mitigate supply-chain attacks.

| Control | Scope and purpose |
| --- | --- |
| `--min-release-age=0` | Temporary flag for a single npm command to allow fresh upstream releases. |
| `PI_PACKAGE_ALLOW_FRESH=1` | Permits fresh packages in packaging verification child processes. |
| `PI_ALLOW_LOCKFILE_CHANGE=1` | Required to commit `npm-shrinkwrap.json` changes that modify third-party packages. |

### Committing lockfile changes

The pre-commit hook automatically permits shrinkwrap changes when updating `@earendil-works/*` packages during upstream syncs or releases. Any other dependency modification requires explicit acknowledgement via `PI_ALLOW_LOCKFILE_CHANGE=1`.

Scope the environment variable to the commit command:

```bash
# Bash:
PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "chore(deps): update <package>"
```

```powershell
# PowerShell:
$env:PI_ALLOW_LOCKFILE_CHANGE = "1"
try { git commit -m "chore(deps): update <package>" }
finally { Remove-Item Env:PI_ALLOW_LOCKFILE_CHANGE }
```
