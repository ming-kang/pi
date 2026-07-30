# Bundled features

The installed `@astralyn/pi` package includes workflow extensions, local-model support, native presentation, and themes on top of its coding-agent behavior.

## Extensions and local models

These hidden built-ins use the same public Extension API available to external extensions. Their implementation details are internal to the package.

| Feature | Tool or command | Purpose |
|---|---|---|
| [`llama.cpp`](../llama-cpp.md) | `/llama` | Manage models served by the local llama.cpp router |
| [DeepWiki](extensions/deepwiki.md) | `deepwiki` | Query indexed public GitHub repository documentation |
| [Question](extensions/question.md) | `question` | Ask structured questions through native interactive UI |
| [Rewind](extensions/rewind.md) | `/rewind`, `/tree` lifecycle | Create and restore project snapshots around session operations |
| [Router](extensions/router.md) | `/router` | Configure and probe Codex-style routing endpoints |
| [Statusline](extensions/statusline.md) | Footer status | Show concise extension-managed activity state |
| [Subagent](extensions/subagent.md) | `subagent`, `/agents` | Delegate bounded work to isolated child Pi sessions |
| [Todo](extensions/todo.md) | `todo`, `/todos` | Track multi-step work with dependencies and status |

## Context safety

After a completed tool batch, Pi checks context before the next provider request. If the active context crosses the configured auto-compaction threshold, Pi compacts and rebuilds it before continuing the same run. Cancellation, compaction failure, an unavailable cut point, or retained context that remains unsafe stops the run.

See [Compaction](../compaction.md).

## Tool presentation

Native tool calls use a consistent `●` call and `│` result shell with bounded collapsed output. Built-in semantic renderers remain responsible for paths, diffs, syntax highlighting, command output, and images.

See [Native tool presentation](tool-presentation.md).

## Themes

The package includes `ice-cream-dark` and `ice-cream-light` alongside the standard `dark` and `light` themes.

See [Bundled themes](themes.md) and [Theme authoring](../themes.md).
