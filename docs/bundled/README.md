# Bundled features

The installed `@astralyn/pi` package includes workflow extensions, local-model support, native presentation, and themes on top of its coding-agent behavior.

## Extensions and local models

These hidden built-ins use the same public Extension API available to external extensions. Their implementation details are internal to the package.

| Feature | Tool or command | Purpose |
|---|---|---|
| [`llama.cpp`](../llama-cpp.md) | `/llama` | Manage models served by the local llama.cpp router |
| [Background](extensions/background.md) | `bg`, `/bg` | Run and manage background shell commands with automatic completion notices |
| [BTW](extensions/btw.md) | `/btw [question]` | Ask temporary side questions with the current context while the main task continues |
| [DeepWiki](extensions/deepwiki.md) | `deepwiki` | Query indexed public GitHub repository documentation |
| [Question](extensions/question.md) | `question` | Ask structured questions through native interactive UI |
| [Provider](extensions/provider.md) | `/provider` | Edit models.json providers: connection, API type, and models |
| [Statusline](extensions/statusline.md) | Footer status | Show concise extension-managed activity state |
| [Subagent](extensions/subagent.md) | `subagent`, `/agents` | Delegate bounded work to isolated child Pi sessions |
| [Todo](extensions/todo.md) | `todo`, `/todos` | Track ordered multi-step work in a compact one-line widget |
| [Web Search](extensions/web-search.md) | `web_search` | Search the live web through MiniMax and DeepSeek with fused results |

## Context safety

After a completed tool batch, Pi checks context before the next provider request. If the active context crosses the configured auto-compaction threshold, Pi compacts and rebuilds it before continuing the same run. Cancellation, compaction failure, an unavailable cut point, or retained context that remains unsafe stops the run.

See [Compaction](../compaction.md).

## Tool presentation

Native tool calls use a consistent `●` call and `│` result shell with bounded collapsed output. Built-in semantic renderers remain responsible for paths, diffs, syntax highlighting, command output, and images.

See [Native tool presentation](tool-presentation.md).

## Themes

The package includes `ice-cream-dark` and `ice-cream-light` alongside the standard `dark` and `light` themes.

See [Bundled themes](themes.md) and [Theme authoring](../themes.md).
