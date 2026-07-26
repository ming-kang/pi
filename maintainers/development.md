# Development

See the repository [AGENTS.md](../AGENTS.md) for the distribution contract and coding conventions.

## Setup

```bash
git clone https://github.com/ming-kang/pi
cd pi
npm install --ignore-scripts
npm run build
npm run check
```

The repository is the standalone `@astralyn/pi` package. AI, Agent core, and TUI are installed as exact upstream npm dependencies; no sibling workspace build is required.

Run from source:

```bash
npm run dev
```

Pi keeps the caller's current working directory. Use `npm run dev -- --no-env` to clear provider credentials for the source run.

## Package identity

Distribution identity and configuration directory defaults are defined in `package.json`:

```json
{
  "name": "@astralyn/pi",
  "piConfig": {
    "configDir": ".pi"
  },
  "bin": {
    "pi": "dist/cli.js"
  }
}
```

## Path resolution

Pi supports npm installation and `tsx` source execution. Always use `src/config.ts` helpers such as `getPackageDir()` and `getThemeDir()` for package assets; do not derive asset paths directly from `__dirname`.

## Debug command

`/debug` (hidden) writes rendered TUI lines and the latest model messages to `~/.pi/agent/pi-debug.log`.

## Testing

```bash
npm run check
node node_modules/vitest/dist/cli.js --run test/specific.test.ts
npm run test:isolated  # complete test suite in an isolated home
```

Release CI runs the full suite on Ubuntu. Interactive UI changes should also be verified in a real terminal.

### Platform-specific test interpretation

For a complete local run, use `npm run test:isolated` rather than invoking Vitest directly. The wrapper starts from an empty environment with temporary home, config, cache, and credential paths; a direct run can discover the developer's real skills, settings, package-manager state, or Git configuration and produce machine-specific failures.

Native Windows is not the release-verification platform. A complete Windows run may fail or differ in tests that assume:

- POSIX `chmod`, writability, or exact `EACCES` behavior;
- unprivileged file or directory symlink creation rather than Windows Developer Mode, elevation, or junctions;
- POSIX path separators and glob semantics;
- Unix signals, suspension, TTYs, `fs.watch`, external editors, or child-process quoting and exit behavior.

These failures must be classified rather than silently ignored. Focused tests for changed code are still required to pass on the development platform. Use the passing Ubuntu GitHub Actions `npm test` job as the authoritative complete-suite result for release verification; Windows-only process tests and real-TTY checks are supplemental coverage because the current CI workflow has no Windows job.

## Project structure

```text
src/                    runtime source
test/                   automated tests and local test helpers
docs/                   distribution-owned user and public API documentation
└── bundled/            shipped distribution feature documentation
examples/               SDK and extension examples
maintainers/            repository-only maintainer documentation
scripts/                package maintenance scripts
```

`maintainers/**` is excluded from the npm package.
