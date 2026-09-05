# Pi

`@astralyn/pi` is a standalone terminal coding agent for work in your projects. It runs locally and supports TypeScript extensions, skills, prompt templates, themes, and pi packages.

## Install

Pi requires Node.js >=22.19.

```bash
npm install -g --ignore-scripts @astralyn/pi
```

Run `pi` in a project directory. For authentication, uninstalling, and a first session, see the [quickstart](docs/quickstart.md).

## Overview

Pi provides interactive and one-shot coding workflows, persistent sessions and context compaction, native tool presentation, and customization through its public extension API. Built-in execution uses Bash by default, with an optional native PowerShell tool on Windows. The installed package also includes bundled workflows, themes, and local-model support.

See the [bundled features overview](docs/bundled/README.md) for the complete shipped-feature and extension catalog.

## Use and customize

- [Using Pi](docs/usage.md) covers interactive commands, context files, CLI usage, and the `--` end-of-options delimiter.
- [Windows setup](docs/windows.md) covers Git Bash and the optional PowerShell tool.
- [Background tasks](docs/bundled/extensions/background.md) covers native shell and whole-Subagent background execution, Ctrl+B handoff, and `/bg` management in interactive mode.
- [Sessions](docs/sessions.md) and [Compaction](docs/compaction.md) cover saved work and context management.
- [Extensions](docs/extensions.md), [Skills](docs/skills.md), [Prompt templates](docs/prompt-templates.md), [Themes](docs/themes.md), and [Pi packages](docs/packages.md) cover customization.
- [SDK](docs/sdk.md), [JSON mode](docs/json.md), and [RPC mode](docs/rpc.md) cover programmatic use.

## Documentation

- [Documentation index](docs/index.md)
- [Quickstart](docs/quickstart.md)
- [Providers](docs/providers.md)
- [Settings](docs/settings.md)
- [Security](docs/security.md)

## License

MIT
