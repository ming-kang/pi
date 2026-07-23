# Fork documentation

This directory contains documentation owned by the `@astralyn/pi` distribution. User and API documentation that stays structurally aligned with upstream remains under [`packages/coding-agent/docs/`](../packages/coding-agent/docs/); Fork-specific material should not be duplicated there.

## User documentation

- [Distribution overview](../README.md) — package identity, installation, bundled features, and development entry points.
- [Quickstart](../packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session.
- [User and API documentation](../packages/coding-agent/docs/index.md) — interactive mode, settings, customization, SDK, RPC, and platform notes.
- [Extension API](../packages/coding-agent/docs/extensions.md) — write external TypeScript extensions.
- [Theme API](../packages/coding-agent/docs/themes.md) — create and load custom themes.

## Fork architecture and design

- [Architecture and ownership boundaries](architecture.md)
- [Native tool presentation](tool-presentation.md)
- [Bundled theme design](themes.md)

## Bundled extensions

- [Catalog](extensions/README.md)
- [deepwiki](extensions/deepwiki.md)
- [question](extensions/question.md)
- [rewind](extensions/rewind.md)
- [router](extensions/router.md)
- [statusline](extensions/statusline.md)
- [todo](extensions/todo.md)

## Maintainer documentation

- [Fork maintenance and upstream synchronization](maintenance.md)
- [OIDC npm release checklist](release.md)
- [Repository contract](../AGENTS.md)
