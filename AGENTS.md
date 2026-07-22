# Repository Contract

This is a private personal distribution of Pi based on `earendil-works/pi`. The repository does not accept external issues or pull requests. Future Contributors may be granted access directly by the owner.

## Ownership and scope

- The repository keeps the complete Pi monorepo so upstream updates remain easy to merge.
- Personal implementation changes belong in `packages/coding-agent/**` unless a real dependency or build requirement makes another package unavoidable.
- `packages/ai`, `packages/agent`, `packages/tui`, `packages/server`, and `packages/storage` follow upstream by default.
- The published user-facing package is `@astralyn/pi`; the command remains `pi`.
- Keep upstream `scripts/` by default even when a removed Fork workflow no longer invokes them; remove only scripts tied to an intentionally unsupported release or governance flow. Fork-owned scripts must be wired through the root `package.json` or a documented process.
- Do not add a Fork framework, feature registry, configuration layer, or extra package for personal behavior.

## Architecture boundaries

- Native tool presentation belongs in `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` and the relevant built-in tool renderers.
- Extensions remain self-contained under `packages/coding-agent/src/extensions/` and use Pi's Extension API.
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
- Use erasable TypeScript syntax only: no `enum`, `namespace`, parameter properties, or other syntax requiring special runtime transforms.
- Never hard-code key checks. Add configurable defaults to `KEYBINDINGS` and use the KeybindingsManager.
- Do not modify `packages/ai/src/models.generated.ts` directly. Change the generator and regenerate model data instead.
- Do not commit credentials, provider tokens, local configuration, or machine-specific paths.

## Checks

After code changes, run:

```bash
npm run check
```

This runs Biome, dependency/import checks, shrinkwrap and install-lock checks, TypeScript checking, and browser smoke checks. Fix all failures before considering the change verified.

Do not run `npm run build`, `npm test`, or the complete test suite unless explicitly requested. For a focused test, run it from the package directory:

```bash
node node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

When a test file changes, run that test and iterate until it passes. Release verification may run `build:offline` and `./test.sh` explicitly.

For interactive verification, use a real TTY. Check the affected pending, success, error, collapsed, and expanded states, plus `/reload` and `/tree` for lifecycle extensions.

## Git and upstream

- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
- Stage explicit paths and inspect `git status` before committing.
- Do not commit unless the owner requests a checkpoint or release commit.
- Use concise Conventional Commit messages with `feat`, `fix`, or `docs` types.
- Keep upstream as the `upstream` remote:

```bash
git fetch upstream
git merge upstream/main
```

Expected merge hotspots are the native tool presentation, `core/tools`, `core/keybindings.ts`, `extensions/index.ts`, and the Fork package metadata.

## Documentation

- Root `README.md` describes this distribution.
- Root `docs/` contains Fork-owned architecture, historical rationale, extension, and theme documentation.
- `packages/coding-agent/docs/` remains primarily upstream usage/API documentation.
- `packages/coding-agent/CHANGELOG.md` is the runtime and release changelog; keep Fork entries under `[Unreleased]`.
- `docs/release.md` is the manual single-package release checklist.
- Do not add contribution, security, governance, issue-triage, or other policy documents unless the owner explicitly asks for them.

## npm distribution

Only `@astralyn/pi` is published. Other workspace packages retain their upstream package names and are not part of the Fork distribution.

Use a numeric npm prerelease suffix that tracks the upstream version:

```text
0.81.1-1
0.81.1-2
0.82.0-1
```

Follow the release checklist in `docs/release.md` when publishing. Do not use the upstream multi-package release or publish workflow for this repository.

## No external tracker

This is a closed collaboration repository. Do not add workflows or templates that auto-close, triage, analyze, approve, or otherwise manage external issues and pull requests.
