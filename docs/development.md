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
./pi-test.sh
```

The script can be invoked from any directory. Pi keeps the caller's current working directory. Use `./pi-test.sh --no-env` to clear provider credentials for the source run.

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
./test.sh  # complete isolated test suite
```

Release CI runs the full suite on Ubuntu. Interactive UI changes should also be verified in a real terminal.

## Project structure

```text
src/                 runtime source
 test/                automated tests and local test helpers
 docs/                product and public API documentation
 examples/            SDK and extension examples
 docs/distribution/   standalone distribution documentation
 scripts/             package maintenance scripts
```
