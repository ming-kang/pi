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
