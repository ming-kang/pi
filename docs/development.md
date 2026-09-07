# Development

This page covers running and testing a source checkout of the standalone `@astralyn/pi` package. Maintainer policy and release operations are documented in the checkout's `maintainers/` directory; that directory is excluded from npm.

## Requirements and setup

Use Node.js `>=22.19.0` and npm 11.15.0, matching CI. Tests require `fd` (or `fdfind`) and `rg`; the isolated runner reuses Pi-managed copies when available.

```bash
npm ci --ignore-scripts
npm run check:installed-deps
npm run dev
```

To remove provider credentials from the child process environment:

```bash
npm run dev -- --no-env
```

`--no-env` only removes the configured environment variables. It still uses the normal agent directory and can read `auth.json`, settings, and extensions there. Use the isolated test runner for automated checks requiring an isolated home and configuration.

## Build and test

```bash
npm run build
npm run check
npm run test:isolated -- test/model-selector.test.ts
npm run test:isolated -- test/model-selector.test.ts -t "configured save binding"
```

The build emits the stable SDK and type declarations, then bundles the CLI, RPC entrypoint, and image-resize worker. Run the resulting CLI with `node dist/cli.js`. After deleting sources or changing build exclusions, run `npm run clean` before building.

Installed dependency versions are checked before npm builds/tests and repository checks. For a complete suite, omit the isolated runner's arguments:

```bash
npm run test:isolated
```

The isolated runner preserves individual arguments and forwards them to Vitest, isolates home/configuration/cache/credentials, and preflights its required tools. Interactive verification requirements are defined by the repository's `AGENTS.md`.

## Experimental remote harness

Server/client integration is source-only. On a POSIX system:

```bash
PI_EXPERIMENTAL=1 npm run dev -- server
PI_EXPERIMENTAL=1 npm run dev -- client
```

The source launcher uses `src/experimental/cli.ts` and falls back to the stable CLI for ordinary commands. `PI_SERVER_DIR` selects the server profile/socket directory (default `~/.pi/server`); `PI_SERVER_ID` selects the server ID when `--server-id` is omitted. The durable server requires POSIX process APIs.

The `client` and `experimental/plugin` package subpaths resolve under the `source` condition in a checkout. Their implementations and commands are excluded from distributed builds; the local SDK and stdio RPC remain supported. The development-only libraries are installed when preparing a source checkout.

## Repository layout

- `src/**`: runtime and source-only experimental code.
- `src/extensions/**`: bundled extensions using the public Extension API.
- `test/**`: tests and fixtures.
- `docs/**`: shipped user and API documentation.
- `maintainers/**`: repository-only architecture, dependency, synchronization, and release guidance.
- `scripts/**`: build and maintenance helpers.
