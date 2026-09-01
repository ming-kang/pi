# Web Search

`web_search` is a Pi-native tool for querying live web information through MiniMax and DeepSeek search engines.

When both engines are configured, searches run concurrently and results are fused with reciprocal-rank scoring: URLs are normalized (tracking parameters and fragments stripped), duplicates are merged, and high-ranked results from both engines remain represented.

| Engine mode | Requirement |
|---|---|
| `dual` | Both MiniMax and DeepSeek keys configured |
| `minimax` | Only a MiniMax key configured |
| `deepseek` | Only a DeepSeek key configured |
| `none` | No key found — the tool reports itself disabled |

## Credentials

Keys are resolved per provider through the runtime's canonical auth chain (`ModelRuntime.getAuth`: runtime API key → `auth.json` → `models.json` → environment). When no runtime is available (or it does not know the provider), the extension falls back to reading `auth.json` directly (provider IDs `minimax-cn`, `minimax`, `deepseek`, including command-configured keys such as `"!op read ..."`) and then the environment variables `MINIMAX_CN_API_KEY`, `MINIMAX_API_KEY`, `DEEPSEEK_API_KEY`.

The MiniMax CN account (`minimax-cn`) is preferred over the global one (`minimax`) and selects the `api.minimaxi.com` search host; the global account uses `api.minimax.io`, overridable via `MINIMAX_API_HOST`.

Configure with `/login minimax-cn` or `/login deepseek`, or by exporting the environment variables above.

When no key is configured, `web_search` is removed from the model's tool set and system prompt entirely — the model never sees or calls it. This is re-evaluated on every session start (`startup`, `/new`, `/reload`, resume, fork). When credentials are available, the extension leaves the host's active-tool set unchanged: normal registration keeps the tool available by default, while an explicit `/tools` or SDK-host disable remains respected until that host enables it again. The tool always stays registered for `/tools` and historical rendering; force-enabling it without keys returns the disabled message.

## Usage

### Parameters

- `query`: the search query, up to 500 characters — 3–5 keywords work best; include a year when freshness matters.

### Output

The model-facing payload is Markdown containing up to 12 HTTP(S) source results. Titles and snippets are bounded to 200 characters each, source URLs to 2048 characters, DeepSeek synthesis to 6000 characters, and up to 8 related searches to 200 characters each. Results found by both providers are tagged as such; this means the URL appeared in both result sets, not that its claims were independently verified. When structured source URLs are present, the tool result reminds the model to cite the relevant URLs without prescribing a heading or response format.

## Limits

- With no configured key the tool is hidden from the model (see Credentials); the disabled message only appears when the tool was force-enabled via `/tools` without keys.
- Engine failures are independent: if one engine errors, the other's results are still returned; the tool errors only when every configured engine fails. Error outcomes are marked as protocol-level tool errors; the credential-disabled warning is not.
- MiniMax search uses the Coding Plan Search endpoint (`POST /v1/coding_plan/search`), which requires a Coding Plan key — a standard MiniMax API key may be rejected upstream.
- DeepSeek search goes through the Anthropic-compatible endpoint (`/anthropic/v1/messages`, model `claude-sonnet-search`) with the server-side `web_search_20250305` tool; the request uses `max_tokens: 1024`, followed by the local output bound above. A response must contain a structured `web_search_tool_result`: an empty result array is a valid zero-result search, while text-only, malformed, or structured-error responses count as a provider failure and their synthesis is discarded.
- Requests time out after 60 seconds (MiniMax) or 90 seconds (DeepSeek) and surface as Pi tool errors. Successful upstream response bodies are limited to 2 MiB, error bodies to 200 bytes, and model-facing error messages to 500 characters.

## Implementation notes

The extension keeps presentation Pi-native: the call line shows the query, in-flight renders show the engine label with elapsed time past 2s, the collapsed result shows hit count, engines, duration, and a top-domain preview with the configured expand hint, and expanding renders the result sections from `details` — without the model-facing agent directives — falling back to the raw payload for legacy entries.

Credential resolution never inspects `getProviderAuthStatus` — that probe returns a truthy `AuthStatus` object even when nothing is configured and carries no key. Only `getAuth` returns usable key material.
