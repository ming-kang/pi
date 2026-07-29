# Repository contract

This is the private standalone distribution of Pi's coding-agent package. It publishes `@astralyn/pi`; its executable remains `pi`. Do not accept external issues or pull requests for this repository.

## Non-negotiable boundaries

- The repository contains one coding-agent package; runtime source is under `src/**`.
- Consume AI, Agent core, and TUI through the exact `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` npm dependencies. Never vendor, patch, monkey-patch, or recreate them.
- Do not recreate a monorepo, workspace aliases, hidden bundled dependencies, a Fork framework, feature registry, or another publishable package.
- Keep native tool presentation in `src/modes/interactive/components/tool-execution.ts` and the relevant built-in renderers. Prefer Pi-native presentation; use `renderShell: "self"` only when a tool intentionally owns its complete UI.
- Extensions are self-contained under `src/extensions/`, use the Extension API, and never import another extension's internals. Prefer small domain-neutral duplication to coupling.
- Keep functional UI with its owning extension and use semantic theme helpers, not hard-coded colors. Display-only work must not change a tool schema, execution protocol, or result structure.
- Bound model-facing output whenever its source can grow without limit.

## Implementation discipline

- Read files completely before broad changes. Use top-level imports only; do not use dynamic imports or inline type imports. Use `.ts` relative TypeScript imports, practical types instead of `any`, and erasable TypeScript syntax only.
- Add configurable key defaults to `KEYBINDINGS` and use the `KeybindingsManager`; never hard-code key checks.
- Pin direct npm dependencies exactly and intentionally regenerate `npm-shrinkwrap.json` when they change.
- Never commit credentials, provider tokens, local configuration, or machine-specific paths.

## Verification and repository safety

- Run `npm run check` after code changes; run focused tests for changed tests or behavior, and build when exports, package metadata, TypeScript configuration, or bundled assets change. Do not run the complete suite unless requested or doing release verification.
- On native Windows, use `npm run test:isolated` for a complete local suite. Treat focused failures as real; Ubuntu CI is authoritative for POSIX-sensitive complete-suite coverage. Verify interactive changes in a real TTY, including their affected pending, settled, collapsed, expanded, `/reload`, and `/tree` states.
- Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`. Stage explicit paths, inspect status before committing, and do not commit without an owner-requested checkpoint or release. Use concise `feat`, `fix`, or `docs` Conventional Commit messages.
- Keep the upstream repository as the `upstream` remote; synchronize only from its release tags, never `upstream/main`, and never merge an upstream monorepo tag into this branch.

## Documentation and release ownership

`README.md` and `docs/**` are distribution-owned user and API documentation; `docs/bundled/**` covers shipped distribution features. `maintainers/**` is repository-only and excluded from npm. `CHANGELOG.md` records this distribution's releases under `[Unreleased]`. Do not add contribution, security-policy, governance, issue-triage, or external-tracker documents without owner approval. Only the root `@astralyn/pi` package is published.

## Maintainer guides

- [Maintainer guide](maintainers/README.md) — architecture boundaries and local development.
- [Upstream synchronization](maintainers/upstream.md) — release-tag adoption and deviation notes.
- [Release](maintainers/release.md) — versioning and publication.
