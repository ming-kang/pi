# Development

This repository is the standalone distribution of `@astralyn/pi`. It publishes one package and the `pi` executable; runtime source lives under `src/**`.

## Requirements

- Node.js `>=22.19`
- npm

The package consumes the published `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` dependencies. It does not recreate the upstream monorepo or vendor those packages.

## Install and run

Install dependencies without running lifecycle scripts:

```bash
npm install --ignore-scripts
```

Run the CLI directly from TypeScript source:

```bash
npm run dev
```

To run without provider credentials from the current environment:

```bash
npm run dev -- --no-env
```

Build the distributable package and assets:

```bash
npm run build
```

The compiled CLI is `dist/cli.js`. The package's executable is `pi`.

## Verification

Run the repository checks after code changes:

```bash
npm run check
```

This runs Biome, dependency and import checks, documentation-link validation, and TypeScript checks for source and examples.

Run focused tests for changed behavior:

```bash
npx vitest run test/<changed-file>.test.ts
```

Run all tests in an isolated home and configuration directory:

```bash
npm run test:isolated
```

Validate the exact upstream release baseline and local deviations:

```bash
npm run diff:upstream -- --check
```

For interactive changes, also test in a real TTY, including pending and settled tool output, collapsed and expanded states, and relevant `/reload` or `/tree` flows.

## Repository layout

- `src/**` - runtime source
- `src/extensions/**` - bundled extensions using the public Extension API
- `test/**` - focused Vitest tests and fixtures
- `docs/**` - published user and API documentation
- `maintainers/**` - repository-only maintainer runbooks
- `scripts/**` - development, verification, and release helpers

## Boundaries

Keep the upstream runtime contracts intact. Do not vendor or patch the AI, Agent core, or TUI dependencies. Preserve tool schemas, execution protocols, and result structures when changing display-only behavior. Keep direct dependencies pinned and regenerate `npm-shrinkwrap.json` intentionally when dependency metadata changes.

Read the repository contract in `AGENTS.md` and the maintainer architecture and release guidance in `maintainers/README.md` before making changes.
