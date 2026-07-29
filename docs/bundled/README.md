# Bundled features

The installed `@astralyn/pi` package includes a small set of workflows and presentation choices on top of its coding-agent behavior.

## Extensions

The following extensions are loaded as hidden built-ins. They use the same public Extension API available to external extensions.

| Extension | Tool or command | Purpose |
|---|---|---|
| [`llama.cpp`](../llama-cpp.md) | `/llama` | Manage models served by the local llama.cpp router |
| `deepwiki` | `deepwiki` | Query indexed public GitHub repository documentation |
| `question` | `question` | Ask structured questions through native interactive UI |
| `rewind` | `/rewind` | Create and restore project snapshots around session lifecycle operations |
| `router` | `/router` | Configure and probe Codex-style routing endpoints |
| `statusline` | Footer status | Show concise extension-managed activity state |
| `subagent` | `subagent`, `/agents` | Delegate bounded work to isolated child Pi sessions |
| `todo` | `todo`, `/todos` | Track multi-step work with dependencies and status |

See the [bundled extension catalog](extensions/README.md) for configuration and behavior details.

## Context safety

After a completed tool batch, Pi checks context before the next provider request. If the active context crosses the configured auto-compaction threshold, Pi compacts and rebuilds it before continuing the same run. Cancellation, compaction failure, an unavailable cut point, or retained context that remains unsafe stops the run.

See [Compaction](../compaction.md).

## Tool presentation

Native tool calls use a consistent `●` call and `│` result shell with bounded collapsed output. Built-in semantic renderers remain responsible for paths, diffs, syntax highlighting, command output, and images.

See [Native tool presentation](tool-presentation.md).

## Themes

The package includes `ice-cream-dark` and `ice-cream-light` alongside the standard `dark` and `light` themes.

See [Bundled themes](themes.md) and [Theme authoring](../themes.md).
