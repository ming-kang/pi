# Repository contract

`@astralyn/pi` is a standalone distribution of Pi coding agent, built on `@earendil-works/*` packages.
[Maintainer guide](maintainers/README.md) maps topics to their owning documents.

## Boundaries

- **Dependencies:** Consume installed `@earendil-works/*` dependencies; never vendor or copy them. See [Architecture](maintainers/architecture.md#dependency-boundary).
- **Capabilities:** Prefer Extension (`src/extensions/`) → Hook + Extension → Core capability. Extensions use the Extension API and never import each other. See [Placing new capabilities](maintainers/architecture.md#placing-new-capabilities).
- **Conventions:** Keys go through `KEYBINDINGS` in `src/core/keybindings.ts`, unbounded output goes through `truncateHead`/`truncateTail`, colors use semantic theme helpers, and imports are top-level only.
- **Upstream sync:** Adopt upstream only from release tags via [Upstream synchronization](maintainers/upstream.md); never merge an upstream tag into `main`. Fix type errors by updating dependencies, not by removing code.

## Verification & Commands

- **Format & lint:** Run `npm run format` then `npm run check` after code changes; fix every diagnostic.
- **Focused tests:** Run `npm run test:isolated -- test/<file>.test.ts [-t "<name>"]`. Never run full `npm test` unasked (it reads the real home directory and can fail on host resources).
- **Upstream ledger:** When modifying or dropping upstream paths, update `maintainers/concerns.json` with the owning concern and covering tests; verify with `npm run diff:upstream -- --check`.
- **Scripts:** Put ad-hoc scripts in a temp file rather than multi-line inline shell strings.

## Testing Rules

- **Observable behavior:** Test observable behavior, not internals, constants, or mock structures. Prefer extending existing tests; for bug fixes, write a failing reproduction first.
- **When to test:** Add a test only when it catches a plausible future bug that types, linter, and existing tests would miss. Docs, renames, refactors, and type-only changes need none.
- **Offline harness:** Tests run offline against the faux provider (`test/suite/harness.ts`); opt in to network with `allowNetwork()`. Never use real credentials.
- **Interactive UI:** Verify terminal UI changes in a real pseudo-terminal per [Interactive testing](maintainers/interactive-testing.md).

## Git & Safety Rules

- **Commit on request:** Commit only when requested by the user or for a release. Stage explicit paths (`git add <path1> <path2>`); review the staged diff before committing. Use Conventional Commits: `<type>[(scope)]: <summary>`.
- **Forbidden git operations:** Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
- **Lockfile changes:** Direct dependencies stay pinned. Staging `npm-shrinkwrap.json` for anything beyond upstream updates requires `PI_ALLOW_LOCKFILE_CHANGE=1`. See [Dependency maintenance](maintainers/dependencies.md).
- **Documentation changes:** `README.md` and `docs/**` are published; `maintainers/**` is internal. Register new docs in `docs/docs.json`. Document user-visible changes in `CHANGELOG.md` under `## [Unreleased]`.
