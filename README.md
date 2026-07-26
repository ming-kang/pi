# Pi

`@astralyn/pi` is a standalone distribution of the Pi terminal coding agent. It follows the coding-agent package from [earendil-works/pi](https://github.com/earendil-works/pi) release tags while shipping its own documentation, bundled workflows, context-safety behavior, and npm release process.

This is not an upstream release. The repository is maintained privately and does not accept external issues or pull requests.

## Install

Pi requires Node.js 22.19 or later.

```bash
npm install -g --ignore-scripts @astralyn/pi
pi
```

Use `/login` for a supported subscription provider, or configure an API key before starting Pi. See the [quickstart](docs/quickstart.md) and [provider guide](docs/providers.md).

`--ignore-scripts` disables dependency lifecycle scripts during installation. Pi does not require install scripts for normal npm installs.

## What This Distribution Ships

The package keeps Pi's extensible terminal coding-agent architecture and adds a small set of built-in behaviors:

- native `●` call and `│` result presentation with bounded collapsed tool output;
- automatic compaction between completed tool batches and the next provider request;
- bundled `deepwiki`, `question`, `rewind`, `router`, `statusline`, `subagent`, and `todo` extensions;
- bundled `ice-cream-dark` and `ice-cream-light` themes;
- exact registry dependencies on the upstream AI, Agent core, and TUI packages.

See [bundled features](docs/bundled/README.md) for the complete catalog.

## Usage

Start an interactive session in a project directory:

```bash
pi
```

Useful commands:

| Command | Purpose |
|---|---|
| `/login` | Authenticate a provider |
| `/model` | Select a configured model |
| `/settings` | Change thinking, theme, queue, and transport settings |
| `/compact` | Manually compact the active context |
| `/tree` | Navigate and branch session history |
| `/resume` | Resume a previous session |
| `/reload` | Reload extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show configured keyboard shortcuts |

Run a one-shot prompt:

```bash
pi -p "Summarize this repository"
```

Include files with `@` arguments:

```bash
pi @README.md "Review this documentation"
```

Run structured modes:

```bash
pi --mode json
pi --mode rpc
```

See [Using Pi](docs/usage.md), [JSON mode](docs/json.md), and [RPC mode](docs/rpc.md).

## Sessions and Context

Sessions are stored as JSONL under `~/.pi/agent/sessions/`. Pi supports persistent branching, labels, forks, cloning, import/export, and context compaction. The full session history remains on disk after compaction.

Pi discovers `AGENTS.md` and `CLAUDE.md` context files from the project and its parent directories. Global instructions can be stored at `~/.pi/agent/AGENTS.md`.

See [Sessions](docs/sessions.md), [Session format](docs/session-format.md), and [Compaction](docs/compaction.md).

## Customization

Pi can be extended without modifying its core:

- [Extensions](docs/extensions.md) add tools, commands, lifecycle handlers, provider integrations, and TUI components.
- [Skills](docs/skills.md) provide on-demand workflows and reference material.
- [Prompt templates](docs/prompt-templates.md) add reusable slash-command prompts.
- [Themes](docs/themes.md) customize terminal presentation.
- [Pi packages](docs/packages.md) distribute those resources through npm or git.

Project-local code and package resources execute with the user's permissions. Review third-party packages and trust a project only when its local configuration and extensions are acceptable.

## Programmatic API

Use the SDK from Node.js:

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@astralyn/pi";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});

await session.prompt("What files are in the current directory?");
```

The package exports its SDK from `@astralyn/pi` and its executable RPC entry point from `@astralyn/pi/rpc-entry`.

See the [SDK guide](docs/sdk.md) and [SDK examples](examples/sdk/README.md).

## Documentation

- [Documentation index](docs/index.md)
- [Quickstart](docs/quickstart.md)
- [Settings](docs/settings.md)
- [Environment variables](docs/environment-variables.md)
- [Bundled features](docs/bundled/README.md)
- [Security](docs/security.md)

Repository architecture, upstream synchronization, development, and publishing are documented in the source repository's [maintainer guide](https://github.com/ming-kang/pi/tree/main/maintainers). Those files are intentionally excluded from the npm package.

## Upstream Boundary

The repository contains only the coding-agent package. AI, Agent core, and TUI are consumed as exact npm dependencies:

- [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
- [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
- [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)

Upstream release tags are reviewed selectively. Their documentation and examples are inputs to synchronization, not files that overwrite this distribution's documentation.

## License

MIT
