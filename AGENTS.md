# Repository contract

 `@astralyn/pi` is a standalone distribution of Pi coding agent, built on `@earendil-works/*` packages. 

[Maintainer guide](maintainers/README.md) maps each topic to the document that owns it.

## Boundaries

- Consume the installed `@earendil-works/*` dependencies; never vendor or recreate them. See [Architecture](maintainers/architecture.md#dependency-boundary).
- Extensions live in `src/extensions/`, use the Extension API, and never import each other's internals.
- Keep tool schemas, execution protocols, and model-facing results stable; presentation is defined in [Native tool presentation](docs/bundled/tool-presentation.md).
- Follow upstream conventions: keys go through `KEYBINDINGS` in `src/core/keybindings.ts`, unbounded model-facing output goes through `truncateHead`/`truncateTail`, colors come from semantic theme helpers, and imports are top-level only.
- Adopt upstream only from release tags via [Upstream synchronization](maintainers/upstream.md) and never merge an upstream tag into this branch. Fix type errors from outdated dependencies by adopting the upstream release that fixes them, not by removing code.
- Backward compatibility is not required unless asked, but ask before removing functionality that looks intentional.

## Communication

Answer questions before editing.

Use plain, concise language; explain non-trivial problems as problem → concrete example → solution.

## Tests

- Add a test only when it would catch a plausible future bug that types, lint, and existing tests would miss; docs, renames, refactors, and type-only changes need none. In the final message, name the bug each new test catches.
- Test observable behavior, not constants, mocks, or implementation details. Prefer extending an existing test; for a bug fix, start from a failing reproduction.
- Run focused tests while iterating: `npm run test:isolated -- test/<file>.test.ts [-t "<name>"]`. Run the complete suite only when asked or for a release, as `npm run test:isolated` with no arguments; plain `npm test` reads your real home and can fail on host resources. Setup: [Development](docs/development.md).
- Tests run offline with the faux provider (`test/suite/harness.ts`); opt in to network per test with `allowNetwork()` from `test/test-network-env.ts`. Never use real credentials.

## Build and verification

- Run `npm run format` then `npm run check` after any change, including docs; fix every diagnostic.
- Dependencies are exactly pinned. Changing one means regenerating `npm-shrinkwrap.json` and committing with `PI_ALLOW_LOCKFILE_CHANGE=1`; see [Dependency maintenance](maintainers/dependencies.md).
- `PI_BUNDLED_NODE` and the upstream bundling strategy are invariants owned by [Architecture](maintainers/architecture.md). Run `npm run clean` before rebuilding after deleting sources.
- For entrypoint or packaging changes, pack and run `npm run verify:package-install -- <tarball>`.
- Verify interactive changes in a real terminal per [Interactive testing](maintainers/interactive-testing.md).
- Put ad-hoc scripts in a temp file rather than a multi-line shell command.

## Git and release

- Commit only at an owner-requested checkpoint or release. Stage explicit paths and review the staged diff; never commit credentials or machine-specific paths.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`; the pre-commit hook is the check gate.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- `README.md` and `docs/**` are published; `maintainers/**` is repository-only. Register new docs pages in `docs/docs.json`.
- Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`; see [Release](maintainers/release.md).
