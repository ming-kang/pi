# Maintainer documentation

These documents describe the private source repository and are not included in the npm package.

- [Architecture](architecture.md) - standalone package, dependency, core, and extension boundaries
- [Development](development.md) - local setup, source execution, and verification
- [Upstream synchronization](upstream-sync.md) - review a coding-agent release tag without recreating the monorepo
- [Release](release.md) - prepare, verify, publish, and tag `@astralyn/pi`
- [Upstream baseline](upstream.json) - machine-readable record of the reviewed release tag, runtime package versions, per-path delta registry, and current upstream-delta budget ceilings
- [Delta](delta.md) - upstream-delta admission and ratchet policy, plus the rationale and re-verification for each delta unit

User-facing documentation belongs under [`docs/`](../docs/index.md), with shipped distribution features documented under [`docs/bundled/`](../docs/bundled/README.md). Upstream README, documentation, and examples are reviewed as semantic input during synchronization, but this distribution owns the wording, routes, examples, and behavior documented in its npm package. The entire `maintainers/**` tree is repository-only and excluded from npm.
