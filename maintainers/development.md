# Development

Follow the repository contract in [`AGENTS.md`](../AGENTS.md). This guide covers local work; release-tag adoption is in [upstream-sync.md](upstream-sync.md).

## Setup and source execution

```bash
git clone https://github.com/ming-kang/pi
cd pi
npm install --ignore-scripts
npm run build
npm run check
```

The checkout is the standalone `@astralyn/pi` package. Its AI, Agent core, and TUI dependencies are exact published npm packages, so no sibling workspace build is required.

Run from source with:

```bash
npm run dev
npm run dev -- --no-env  # source run without provider credentials
```

Pi keeps the caller's working directory. Use the asset-resolution helpers in `src/config.ts` rather than deriving package asset paths from `__dirname`.

## Debugging

The hidden `/debug` command writes rendered TUI lines and recent model messages to `~/.pi/agent/pi-debug.log`.

## Focused verification

Run the focused test that covers changed behavior, then the normal check:

```bash
node node_modules/vitest/dist/cli.js --run test/specific.test.ts
npm run check
```

Use a real terminal for interactive changes. Verify the affected pending, settled, collapsed, and expanded states, and `/reload` or `/tree` when lifecycle extensions are involved.

`npm run diff:upstream -- --check` is boundary verification: it compares the current worktree, including staged, unstaged, and nonignored untracked files, with the canonical upstream tree and manifest registry. Run it whenever a change might affect the upstream delta; [upstream-sync.md](upstream-sync.md) and [delta.md](delta.md) own its policy and registry procedure.

## Platform interpretation

For a complete local test run, use:

```bash
npm run test:isolated
```

The isolated wrapper starts with temporary home, configuration, cache, and credential locations. A direct complete Vitest run can discover real user skills, settings, package-manager state, or Git configuration and produce machine-specific failures.

Native Windows is not the authoritative complete-suite platform. POSIX permissions and `EACCES` behavior, symlink capability, path/glob handling, signals, TTYs, watchers, external editors, and child-process quoting can differ or need Developer Mode. Classify those differences rather than ignoring them, and require focused changed-code tests to pass locally. The Ubuntu GitHub Actions complete-suite result is authoritative for release verification; Windows process and real-TTY checks remain valuable supplemental coverage.
