# Bundled features

The installed `@astralyn/pi` package includes features from [upstream Pi](https://github.com/earendil-works/pi) and additions maintained by this distribution.

## Upstream Pi extensions

These extensions are provided by upstream Pi and included in this package:

| Feature | Tool or command | Purpose |
|---|---|---|
| [`llama.cpp`](../llama-cpp.md) | `/llama` | Manage models served by the local llama.cpp router |
| [Codemode](../usage.md#enable-codemode) | `codemode` | Run JavaScript that calls tools and filters their results |
| [MCP](../mcp.md) | `/mcp`, `pi mcp` | Connect MCP servers, manage authentication, and expose their tools and resources |
| [Tool search](../usage.md#tool-search) | `tool_search` | Find deferred tools and declare them for the next model call |

## Distribution extensions

The following extensions are additions maintained by `@astralyn/pi`:

| Feature | Tool or command | Purpose |
|---|---|---|
| [BTW](extensions/btw.md) | `/btw [question]` | Ask temporary side questions with the current context while the main task continues |
| [DeepWiki](extensions/deepwiki.md) | `deepwiki` | Query indexed public GitHub repository documentation |
| [Question](extensions/question.md) | `question` | Ask structured questions through native interactive UI |
| [Provider](extensions/provider.md) | `/provider` | Edit models.json providers: connection, API type, and models |
| [Statusline](extensions/statusline.md) | Footer status | Show concise extension-managed activity state |

All bundled extensions use the public Extension API. Enable or disable them in `pi config` or through `builtin:<name>` entries in [settings](../settings.md#codemode-and-tool-selection). `--no-extensions` disables them; `-e builtin:<name>` loads one explicitly.

## Tasks

[Tasks](tasks.md) is a distribution-owned built-in capability, with the `tasks` tool and `/tasks` panel for native shell commands and extension-owned work. Ctrl+B hands foreground work to the background without restarting it.

## Context safety

Upstream Pi checks context after a completed tool batch and before the next provider request. If the active context crosses the configured auto-compaction threshold, Pi compacts and rebuilds it before continuing the same run. Cancellation, compaction failure, an unavailable cut point, or retained context that remains unsafe stops the run. This distribution adds a percentage-based trigger setting to upstream's compaction lifecycle.

See [Compaction](../compaction.md).

## Tool presentation

This distribution presents native tool calls as compact blocks: a `●` marker whose color is the tool's state and a `│` rail for everything that belongs to it, with no blank line between consecutive tools. Built-in semantic renderers remain responsible for paths, diffs, syntax highlighting, command output, and images.

See [Native tool presentation](tool-presentation.md).

## Themes

Upstream Pi provides `system`, `dark`, and `light`. This distribution adds `ice-cream-dark` and `ice-cream-light`.

See [Bundled themes](themes.md) and [Theme authoring](../themes.md).
