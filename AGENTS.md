# Repository contract

This repo is a standalone distribution of Pi coding agent, `@astralyn/pi`. [Maintainer guide](maintainers/README.md) maps each rule to the document that owns it.

## Boundaries

- Consume the installed `@earendil-works/*` npm dependencies; never vendor or recreate them. Dependency scope and classification: [Architecture](maintainers/architecture.md#dependency-boundary).
- Extensions are under `src/extensions/` and use the Extension API; never import another extension's internals. Prefer small domain-neutral duplication to coupling.
- Keep tool schemas, execution protocols, and model-facing results stable. Tool presentation is defined in [Native tool presentation](docs/bundled/tool-presentation.md) and owned by [Architecture](maintainers/architecture.md).
- Keep functional UI with its owning extension and use semantic theme helpers, not hard-coded colors.

## Conversational style

- Use concise, clear, simple language; define unavoidable jargon before using it. Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- Explain non-trivial designs and problems as problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- When the user asks a question, answer it first before making edits or running implementation commands.

## Code quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Check installed types in `node_modules` for external APIs instead of guessing; no `any` unless absolutely necessary.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only; lazy loading belongs in the extension loader and optional native dependencies.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `KEYBINDINGS` in `src/core/keybindings.ts` and resolve keys through `KeybindingsManager` so they stay configurable.
- Bound model-facing output whenever its source can grow without limit; use the existing `truncateHead`/`truncateTail` helpers in `src/core/tools/truncate.ts` rather than ad-hoc slicing.
- Never remove or downgrade code to fix type errors from outdated dependencies; adopt the upstream release that carries the fix instead, per [Upstream synchronization](maintainers/upstream.md).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Principles for Testing

- **Write tests first.** Before you implement, list the realistic ways the code could fail. Write tests for those cases, then implement against them. Don't add unit tests after the fact.
- **Use E2E tests to verify complex features.** Choose a realistic scenario of medium difficulty, not the easiest happy path. The final run should leave a repeatable artifact (logs, output, screenshots) that someone else can inspect.
- **Test behavior, not implementation.** Don't write tautological or change-detector tests. Only add a regression test for a bug fix if it covers behavior that nothing else tests.
- **Run tests in proportion to the change.** While you iterate, run focused checks; run the complete suite only at an owner-requested checkpoint or when preparing a release, never for trivial edits like wording or formatting.

## Dependencies, build, and packaging

- Keep direct npm dependencies exactly pinned. A scope or version change means regenerating `npm-shrinkwrap.json` intentionally and committing that change with `PI_ALLOW_LOCKFILE_CHANGE=1`. Procedure: [Dependency maintenance](maintainers/dependencies.md).
- `PI_BUNDLED_NODE` must stay defined and `npm run build` must keep following the released upstream bundling strategy; [Architecture](maintainers/architecture.md) owns the invariants. Run `npm run clean` before rebuilding after deleting sources or changing build exclusions.
- For entrypoint, dependency-scope, or packaging changes, pack the package and run `npm run verify:package-install -- <tarball>`.

## Verification

- Put ad-hoc scripts in a temp file, run the file, and remove it when done; do not embed multi-line scripts in a shell command.
- Run `npm run format` and then `npm run check` after code changes; fix every error, warning, and info before committing.
- Run focused tests for changed tests or behavior: `npm run test:isolated -- test/<file>.test.ts [-t "<name>"]`. Always run a test you create or modify and treat a focused failure as real; POSIX-sensitive coverage comes from the complete suite in CI. On Windows the isolated runner takes the complete suite, so invoke it deliberately. Commands and setup: [Development](../docs/development.md).
- Tests run offline (`PI_OFFLINE=1`); opt in per test with `allowNetwork()` from `test/test-network-env.ts`. Never use real provider credentials or paid tokens; suite tests use `test/suite/harness.ts` with the faux provider.
- Verify interactive changes in a real terminal per [Interactive testing](maintainers/interactive-testing.md).

## Git and commits

- Never commit credentials, provider tokens, local configuration, or machine-specific paths. Stage explicit paths; never `git add -A` or `git add .`. Inspect `git status` and the staged diff before committing, and never commit without an owner-requested checkpoint or release.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`. The pre-commit hook is the check gate; do not bypass it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>[(scope)]: <summary>` with a type such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`. Keep them concise, with further lines only when they carry information.
- Adopt upstream only from release tags recorded in `maintainers/upstream.json` through [Upstream synchronization](maintainers/upstream.md); never from a branch tip, and never merge an upstream monorepo tag into this branch.

## Documentation and release

- `README.md` and `docs/**` are distribution-owned user and API documentation, with `docs/bundled/**` for shipped distribution features; `maintainers/**` is repository-only and excluded from npm, and only the root `@astralyn/pi` package is published.
- Documentation is checked: local links must resolve with exact casing, published docs must not link to repository-only paths such as `maintainers/**`, and a new page must be registered in `docs/docs.json`.
- Record this distribution's releases in `CHANGELOG.md` under `## [Unreleased]`; [Release](maintainers/release.md) owns versioning, publication, and tags.
