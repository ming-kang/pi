# Distribution documentation

This directory contains documentation owned by the standalone `@astralyn/pi` distribution. Product usage and public API documentation inherited from upstream coding-agent lives one level above under `docs/`.

## User documentation

- [Distribution overview](../../README.md) — package identity, installation, bundled features, and development entry points.
- [Quickstart](../quickstart.md) — install, authenticate, and run a first session.
- [User and API documentation](../index.md) — interactive mode, settings, customization, SDK, RPC, and platform notes.
- [Extension API](../extensions.md) — write external TypeScript extensions.
- [Theme API](../themes.md) — create and load custom themes.

## Architecture and design

- [Architecture and dependency boundaries](architecture.md)
- [Native tool presentation](tool-presentation.md)
- [Bundled theme design](themes.md)

## Bundled extensions

- [Catalog](extensions/README.md)
- [deepwiki](extensions/deepwiki.md)
- [question](extensions/question.md)
- [rewind](extensions/rewind.md)
- [router](extensions/router.md)
- [statusline](extensions/statusline.md)
- [subagent](extensions/subagent.md)
- [todo](extensions/todo.md)

## Maintainer documentation

- [Upstream synchronization](maintenance.md)
- [OIDC npm release checklist](release.md)
- [Repository contract](../../AGENTS.md)
