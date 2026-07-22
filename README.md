# Pi

A personal Pi distribution based on [earendil-works/pi](https://github.com/earendil-works/pi).

This repository is maintained privately by its owner and invited Contributors. It does not accept external issues or pull requests.

## What this version changes

- Native tool calls use a consistent `●` call / `│` result presentation.
- Generic tool output is bounded in collapsed view and expands with `Ctrl+O`.
- `edit` keeps its Diff preview while using the native tool shell.
- Personal workflow extensions are bundled into `@astralyn/pi`:
  `deepwiki`, `question`, `todo`, `rewind`, `router`, and `statusline`.
- `ice-cream-dark` and `ice-cream-light` are bundled themes.

The rest of the monorepo follows upstream as closely as possible. Personal code changes are intentionally concentrated in `packages/coding-agent/**`.

## Distribution

The published CLI package is:

```text
@astralyn/pi
```

After a release is published, install it with:

```bash
npm install -g @astralyn/pi
```

The executable remains `pi`. The package keeps Pi's existing configuration and session locations under `~/.pi/agent`.

For source development without replacing the globally installed package, run the checkout directly:

```bash
./pi-test.sh --no-env
```

Releases are verified on Ubuntu and published through a manually triggered GitHub Actions workflow using npm Trusted Publishing (OIDC). See the [release checklist](docs/release.md).

## Bundled extensions

| Extension | Purpose |
|---|---|
| `deepwiki` | Query generated DeepWiki documentation for public GitHub repositories. |
| `question` | Ask structured multiple-choice questions through a TUI dialog. |
| `todo` | Maintain a conversation-backed task list with `/todos` and a live overlay. |
| `rewind` | Checkpoint Pi `edit`/`write` changes and restore them through `/tree`. |
| `router` | Configure Codex-style API relays through `/router`. |
| `statusline` | Display a compact two-line model, context, path, Git, and usage footer. |

## Bundled themes

- `ice-cream-dark`
- `ice-cream-light`

Select one in `/settings`, or use an automatic pair:

```json
{
  "theme": "ice-cream-light/ice-cream-dark"
}
```

## Documentation

Fork-specific architecture and behavior are documented in [`docs/`](docs/README.md).

The complete upstream coding-agent usage and API documentation remains under [`packages/coding-agent/docs/`](packages/coding-agent/docs/).

- [Fork architecture](docs/architecture.md)
- [Native tool presentation](docs/tool-presentation.md)
- [Bundled extensions](docs/extensions/README.md)
- [Bundled themes](docs/themes.md)
- [Release checklist](docs/release.md)
- [Coding-agent usage documentation](packages/coding-agent/docs/index.md)

## Development

Install dependencies without lifecycle scripts:

```bash
npm install --ignore-scripts
```

Run the source CLI:

```bash
./pi-test.sh
```

Run formatting, linting, import, lockfile, type, and browser checks:

```bash
npm run check
```

Builds, full tests, and npm publishing are release operations rather than the normal edit loop. See [`AGENTS.md`](AGENTS.md) for the project contract.

## Upstream synchronization

This repository follows the upstream Pi repository through the `upstream` remote:

```bash
git fetch upstream
git merge upstream/main
```

The root README, `AGENTS.md`, `docs/`, and the personal extensions are Fork-owned. The remaining monorepo is primarily upstream-owned and should be changed only when the Fork requires it.

## License

MIT. This project retains the upstream Pi license and attribution.
