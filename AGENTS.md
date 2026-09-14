# Repository contract

This repo is a standalone distribution of Pi's coding agent, `@astralyn/pi`. [Maintainer guide](maintainers/README.md) maps rules to the document that owns it.

## Boundaries

- One coding-agent package, runtime source under `src/**`. Do not add a monorepo.
- Consume the exact installed `@earendil-works/*` npm dependencies; never vendor, patch, monkey-patch, or recreate them.
- Classify dependencies by their consumers; dependency scope, ownership, and bundling rationale are owned by [Architecture](maintainers/architecture.md#dependency-boundary).
- Extensions are self-contained under `src/extensions/`, use the Extension API, and never import another extension's internals. Prefer small domain-neutral duplication to coupling.
- Keep presentation native: the call/result shell, states, and fallback rendering stay in `src/modes/interactive/components/tool-execution.ts` and the built-in renderers, and `renderShell: "self"` is only for a tool that intentionally owns its complete UI. [Native tool presentation](docs/bundled/tool-presentation.md) owns the details.
- Keep functional UI with its owning extension and use semantic theme helpers, not hard-coded colors. Display-only work must not change a tool schema, execution protocol, or result structure.

## Conversational style

- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Check installed types in `node_modules` for external APIs; don't guess.
- Use relative `.ts` TypeScript imports; `scripts/check-ts-relative-imports.mjs` rejects relative `.js` specifiers.
- No `any` unless absolutely necessary.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only; lazy loading belongs in the extension loader and optional native dependencies.
- Use only erasable TypeScript syntax in code checked by the root configs (`src/**`, `test/**`, `examples/**`, `vitest.config.ts`; `examples/extensions/gondolin/**` is excluded): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JavaScript emit. Use explicit fields with constructor assignments.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `KEYBINDINGS` in `src/core/keybindings.ts` and resolve keys through `KeybindingsManager` so they stay configurable.
- Bound model-facing output whenever its source can grow without limit; use the existing `truncateHead`/`truncateTail` helpers in `src/core/tools/truncate.ts` rather than ad-hoc slicing.
- Inline single-line helpers that have only one call site.
- Never remove or downgrade code to fix type errors from outdated dependencies; adopt the upstream release that carries the fix instead, per [Upstream synchronization](maintainers/upstream.md).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Dependencies and build

- Pin direct npm dependencies exactly and regenerate `npm-shrinkwrap.json` intentionally when versions or scope change; [Dependency maintenance](maintainers/dependencies.md) owns installation, age exceptions, and lockfile acknowledgement.
- `npm run build` must keep following the released upstream bundling strategy, and `PI_BUNDLED_NODE` must stay defined so bundled Node extension loading uses embedded virtual modules. [Architecture](maintainers/architecture.md) owns the invariants; re-verify a packed installation when entrypoints or lazy loaders change.

## Verification

- Put ad-hoc scripts in a temp file, run the file, remove it when done; do not embed multi-line scripts in a shell command.
- Run `npm run format` and then `npm run check` after code changes; fix every error, warning, and info before committing. Build when exports, package metadata, TypeScript configuration, or bundled assets change, and run `npm run clean` first after deleting sources or changing build exclusions.
- Run focused tests for changed tests or behavior: `npm run test:isolated -- test/<file>.test.ts [-t "<name>"]`. Always run a test you create or modify. Do not run the complete suite unless requested or preparing a release.
- Tests run offline (`PI_OFFLINE=1`); opt in per test with `allowNetwork()` from `test/test-network-env.ts`. Never use real provider credentials or paid tokens; suite tests use `test/suite/harness.ts` with the faux provider.
- On native Windows, `npm run test:isolated` runs the complete local suite: it preflights `fd`/`fdfind` and `rg` and isolates home, configuration, cache, and credentials. Treat focused failures as real; Ubuntu CI is authoritative for POSIX-sensitive complete-suite coverage.
- Verify interactive changes in a real TTY, including their affected pending, settled, collapsed, expanded, `/reload`, and `/tree` states.
- For entrypoint, dependency-scope, or packaging changes, pack the package and run `npm run verify:package-install -- <tarball>`.

## Git and commits

- Never commit credentials, provider tokens, local configuration, or machine-specific paths.
- Stage explicit paths; never `git add -A` or `git add .`. Inspect `git status` and the staged diff before committing, and never commit without an owner-requested checkpoint or release.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`. The pre-commit hook is the check gate; do not bypass it.
- Commit messages: `feat|fix|docs[(scope)]: <summary>`, concise, with further lines only when they carry information.
- The hook also runs `scripts/check-lockfile-commit.mjs` and `npm run diff:upstream -- --check --staged`. An intentional `npm-shrinkwrap.json` change needs review and `PI_ALLOW_LOCKFILE_CHANGE=1` on that commit. A missing baseline tree requires fetching the exact tag in `maintainers/upstream.json`; the hook never fetches or changes refs.
- Keep the upstream repository as the `upstream` remote. Adopt upstream only from release tags recorded in `maintainers/upstream.json` and compared against that tree, never from a branch tip, and never merge an upstream monorepo tag into this branch. Follow [Upstream synchronization](maintainers/upstream.md).

## Documentation and release

- `README.md` and `docs/**` are distribution-owned user and API documentation; `docs/bundled/**` covers shipped distribution features. `maintainers/**` is repository-only and excluded from npm, and only the root `@astralyn/pi` package is published.
- Documentation is checked: local links must resolve with exact casing, published docs must not link to repository-only paths such as `maintainers/**`, and a new page must be registered in `docs/docs.json`.
- Record this distribution's releases in `CHANGELOG.md` under `## [Unreleased]`; [Release](maintainers/release.md) owns versioning, publication, and tags.
