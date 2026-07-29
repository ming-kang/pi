# @astralyn/pi user and API documentation

The installed `@astralyn/pi` package provides a terminal coding agent that stays small at the core and can be extended through TypeScript extensions, skills, prompt templates, themes, and pi packages.

This documentation describes installed-package behavior, including bundled features and public APIs.

## Quick start

Install Pi with npm. Pi requires Node.js >=22.19.

```bash
npm install -g --ignore-scripts @astralyn/pi
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Pi does not require install scripts for normal npm installs.

To uninstall the npm package:

```bash
npm uninstall -g @astralyn/pi
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @astralyn/pi`, `yarn global remove @astralyn/pi`, or `bun uninstall -g @astralyn/pi`.

Then run it in a project directory:

```bash
pi
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting pi.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Pi](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [llama.cpp](llama-cpp.md) - run a local router and manage models with `/llama`.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox pi with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Bundled features

The installed package includes built-in extensions, themes, and native tool presentation:

- [Bundled overview](bundled/README.md) - package features and how they fit together.
- [Bundled extensions](bundled/extensions/README.md) - catalog and links to every bundled extension.
- [Biu](bundled/extensions/biu.md) - guide a project through interview, task decomposition, execution, and archive.
- [DeepWiki](bundled/extensions/deepwiki.md) - query indexed public GitHub repository documentation.
- [Question](bundled/extensions/question.md) - ask structured questions through native interactive UI.
- [Rewind](bundled/extensions/rewind.md) - create and restore project snapshots around session operations.
- [Router](bundled/extensions/router.md) - configure and probe Codex-style routing endpoints.
- [Statusline](bundled/extensions/statusline.md) - show concise extension-managed activity state.
- [Subagent](bundled/extensions/subagent.md) - delegate bounded work to isolated child Pi sessions.
- [Todo](bundled/extensions/todo.md) - track multi-step work with dependencies and status.
- [Bundled themes](bundled/themes.md) - the ice-cream themes included with the package.
- [Native tool presentation](bundled/tool-presentation.md) - the shared tool-call and result layout.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Pi packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Reference

- [Environment variables](environment-variables.md) - Pi process configuration and session metadata available to bash tools.
- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Programmatic usage

- [SDK](sdk.md) - embed pi in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)
