# Repository Contract

This is a private standalone distribution of Pi's coding-agent package. It publishes `@astralyn/pi`; the executable remains `pi`. The repository does not accept external issues or pull requests.

## Ownership and scope

- This repository contains only the coding-agent package. Runtime source belongs in `src/**`.
- AI, Agent core, and TUI behavior comes from exact upstream npm dependencies: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui`.
- Do not vendor, patch, monkey-patch, or recreate those upstream packages. Upgrade their exact versions when synchronizing to a compatible upstream coding-agent release.
- Do not reintroduce a monorepo, workspace aliases, hidden bundled dependencies, a Fork framework, feature registry, or extra publishable package.

## Architecture boundaries

- Native tool presentation belongs in `src/modes/interactive/components/tool-execution.ts` and the relevant built-in tool renderers.
- Extensions remain self-contained under `src/extensions/` and use Pi's Extension API.
- Do not import one extension's internals from another extension. Small domain-neutral duplication is preferable to coupling.
- Pi-native tool UI is the default. Do not add custom `renderShell`, `renderCall`, or `renderResult` unless native presentation cannot express the required behavior.
- Keep `renderShell: "self"` as the escape hatch for tools that intentionally own their complete UI.
- Functional UI belongs to the owning extension and must use semantic theme helpers instead of hard-coded colors.
- Do not change tool schemas, execution protocols, or result structures when the request is only about display.
- Model-facing output must be bounded when a source can be arbitrarily large.

## Code conventions

- Read files completely before wide-ranging changes.
- Use top-level imports only; do not use dynamic imports or inline type imports.
- Relative TypeScript imports use the `.ts` suffix.
- Avoid `any` unless there is no practical typed alternative.
- Use erasable TypeScript syntax only: no `enum`, `namespace`, parameter properties, or syntax requiring special runtime transforms.
- Never hard-code key checks. Add configurable defaults to `KEYBINDINGS` and use the KeybindingsManager.
- Keep direct npm dependencies pinned to exact versions and regenerate `npm-shrinkwrap.json` intentionally.
- Do not commit credentials, provider tokens, local configuration, or machine-specific paths.

## Checks

After code changes, run:

```bash
npm run check
```

For a focused test:

```bash
node node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

When a test changes, run it and iterate until it passes. Run `npm run build` when source exports, package metadata, TypeScript configuration, or bundled assets change. Do not run the complete test suite unless explicitly requested or performing release verification.

For interactive verification, use a real TTY. Check affected pending, success, error, collapsed, and expanded states, plus `/reload` and `/tree` for lifecycle extensions.

## Git and upstream

- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
- Stage explicit paths and inspect `git status` before committing.
- Do not commit unless the owner requests a checkpoint or release commit.
- Use concise Conventional Commit messages with `feat`, `fix`, or `docs` types.
- Keep upstream as the `upstream` remote and synchronize against release tags, never upstream `main`.
- Do not merge an upstream monorepo tag into this standalone branch. Extract and review only `packages/coding-agent/**`, then update the exact upstream npm dependency versions for that release.

## Documentation

- `README.md` is both the repository and npm package overview.
- `docs/**` contains product usage and API documentation inherited from upstream coding-agent.
- `docs/distribution/**` contains distribution-owned architecture, maintenance, extension, theme, and release documentation.
- `CHANGELOG.md` is the runtime and release changelog; keep Fork entries under `[Unreleased]`.
- Do not add contribution, security-policy, governance, issue-triage, or external-tracker documents unless the owner explicitly asks.

## npm distribution

Only the root package `@astralyn/pi` is published. Fork versions track the upstream `major.minor` line while the patch number is owned by this distribution:

```text
upstream 0.82.x -> Fork 0.82.0, 0.82.1, 0.82.2, ...
upstream 0.83.x -> Fork 0.83.0, 0.83.1, 0.83.2, ...
```

Start at patch `0` when moving to a new upstream minor, then increment the Fork patch for every later release on that line. Tag releases as `pi-v<full-version>` so fetched upstream tags remain distinct. Follow `docs/distribution/release.md` when publishing.
