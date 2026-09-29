# Bundled features

The installed `@astralyn/pi` package includes workflow extensions, local-model support, native presentation, and themes on top of its coding-agent behavior.

## Extensions and local models

These hidden built-ins use the same public Extension API available to external extensions. Their implementation details are internal to the package.

| Feature | Tool or command | Purpose |
|---|---|---|
| [`llama.cpp`](../llama-cpp.md) | `/llama` | Manage models served by the local llama.cpp router |
| [BTW](extensions/btw.md) | `/btw [question]` | Ask temporary side questions with the current context while the main task continues |
| [DeepWiki](extensions/deepwiki.md) | `deepwiki` | Query indexed public GitHub repository documentation |
| [Explore](extensions/explore.md) | `explore`, `/explore` | Investigate code with a temporary read-only agent and choose its model |
| [Question](extensions/question.md) | `question` | Ask structured questions through native interactive UI |
| [Provider](extensions/provider.md) | `/provider` | Edit models.json providers: connection, API type, and models |
| [Statusline](extensions/statusline.md) | Footer status | Show concise extension-managed activity state |
| [Todo](extensions/todo.md) | `todo`, `/todos` | Track ordered multi-step work in a compact one-line widget |
| [Web Search](extensions/web-search.md) | `web_search` | Search the live web through MiniMax and DeepSeek with fused results |

## Tasks

[Tasks](tasks.md) is a built-in capability, with the `tasks` tool and `/tasks` panel for native shell commands and extension-owned work. Ctrl+B hands foreground work to the background without restarting it.

## Context safety

After a completed tool batch, Pi checks context before the next provider request. If the active context crosses the configured auto-compaction threshold, Pi compacts and rebuilds it before continuing the same run. Cancellation, compaction failure, an unavailable cut point, or retained context that remains unsafe stops the run.

See [Compaction](../compaction.md).

## Tool presentation

Native tool calls are compact blocks: a `●` marker whose color is the tool's state and a `│` rail for everything that belongs to it, with no blank line between consecutive tools. Built-in semantic renderers remain responsible for paths, diffs, syntax highlighting, command output, and images.

See [Native tool presentation](tool-presentation.md).

## Themes

The package includes `ice-cream-dark` and `ice-cream-light` alongside the standard `dark` and `light` themes.

See [Bundled themes](themes.md) and [Theme authoring](../themes.md).
