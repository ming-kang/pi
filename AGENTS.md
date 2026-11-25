# Repository contract

`@astralyn/pi` is a standalone distribution of Pi coding agent, built on `@earendil-works/*` packages.
See [Maintainer guide](maintainers/README.md) for topic ownership.

## Boundaries & Code

- **Dependencies:** Consume installed `@earendil-works/*` packages; never vendor or copy them ([Architecture](maintainers/architecture.md#dependency-boundary)).
- **Placement:** Prefer Extension (`src/extensions/`) → Hook + Extension → Core. Extensions use the Extension API and never import each other ([Placing new capabilities](maintainers/architecture.md#placing-new-capabilities)).
- **Conventions:** Register keys via `src/core/keybindings.ts` (core) or `src/core/keybinding-registry.ts` (extensions); bound unbounded output with `truncateHead`/`truncateTail`; use semantic theme helpers; keep imports top-level only.
- **Comments:** Skip obvious comments; comment only non-obvious "why" or external constraints, briefly.
- **Upstream sync:** Adopt upstream only from release tags via [Upstream synchronization](maintainers/upstream.md); never merge an upstream tag into `main`. Fix type errors by updating dependencies, not by deleting code.

## Verification

- **Format & check:** Run `npm run format` then `npm run check` after code changes; fix every diagnostic.
- **Focused tests:** Run `npm run test:isolated -- test/<file>.test.ts [-t "<name>"]`. Never run full `npm test` unasked (it reads the real home directory and can fail on host resources).
- **Upstream ledger:** When modifying or dropping upstream paths, update `maintainers/concerns.json` with the owning concern and covering tests, and verify with `npm run diff:upstream -- --check`.
- **Ad-hoc scripts:** Write temporary scripts to a file instead of multi-line inline shell strings.

## Testing

- **Behavior over internals:** Test observable behavior, not internals, constants, or mock structures. Prefer extending existing tests; write a failing reproduction first for bug fixes.
- **Signal only:** Add tests only for plausible regressions that types, linter, and existing tests would miss (skip for docs, renames, pure refactors, or type-only changes).
- **Offline & UI:** Use the offline faux harness (`test/suite/harness.ts`); opt in to network via `allowNetwork()` and never use real credentials. Verify TUI changes in a real PTY per [Interactive testing](maintainers/interactive-testing.md).

## Git & Docs

- **Commits:** Commit only on request. Stage explicit paths, review `git status` and the staged diff, and use Conventional Commits (`<type>[(scope)]: <summary>`).
- **Forbidden git commands:** Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
- **Lockfile:** Keep direct dependencies pinned; staging `package-lock.json` outside upstream sync requires `PI_ALLOW_LOCKFILE_CHANGE=1` ([Dependency maintenance](maintainers/dependencies.md)).
- **Changelog:** Log user-visible changes since the last release in `CHANGELOG.md` under `## [Unreleased]`.
